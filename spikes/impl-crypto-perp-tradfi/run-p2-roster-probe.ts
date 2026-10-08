/**
 * P2 名册探针（真实网络，只读公共端点）：OKX SPOT ∪ SWAP 名册与 TradFi 元数据实测、
 * Binance 现货/合约可达性核验（本机预期 451 地域封禁）。
 *
 * 用法：node_modules/.bin/tsx spikes/impl-crypto-perp-tradfi/run-p2-roster-probe.ts
 *
 * 产物（同目录）：
 *   okx-instruments-SWAP.json                  OKX SWAP 原始响应（500 行，含 instCategory/ctVal/lever）
 *   okx-instruments-SPOT-category-index.json   SPOT 原始响应 1.2MB，只落分类索引与样本（不落全量）
 *   binance-geo-block.json                     Binance 现货/合约端点的 HTTP 状态与原始响应体
 *
 * 三类断言与连接器解析走的是**同一份真实响应**：探针直接调用连接器源码的
 * OkxRestClient.listInstruments / BinanceRestClient.listInstruments。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BinanceRestClient, TradingServiceError as BinanceError } from '../../packages/connector-binance/src/rest.ts'
import { OkxRestClient, TradingServiceError as OkxError } from '../../packages/connector-okx/src/rest.ts'

const DIR = dirname(fileURLToPath(import.meta.url))
mkdirSync(DIR, { recursive: true })

const OKX_BASE = 'https://openapi.okx.com'
const BINANCE_SPOT = 'https://api.binance.com'
const BINANCE_FAPI = 'https://fapi.binance.com'

async function getRaw(url) {
  const res = await fetch(url)
  const text = await res.text()
  return { status: res.status, text }
}

/* 1) OKX：原始响应落档 + 分类索引 */
const swapRaw = await getRaw(`${OKX_BASE}/api/v5/public/instruments?instType=SWAP`)
writeFileSync(join(DIR, 'okx-instruments-SWAP.json'), swapRaw.text)
const spotRaw = await getRaw(`${OKX_BASE}/api/v5/public/instruments?instType=SPOT`)

const spotRows = JSON.parse(spotRaw.text).data
const spotCategories = {}
for (const row of spotRows) {
  const key = String(row.instCategory)
  if (spotCategories[key] === undefined) spotCategories[key] = { count: 0, sampleInstIds: [], sampleRow: row }
  spotCategories[key].count += 1
  if (spotCategories[key].sampleInstIds.length < 8) spotCategories[key].sampleInstIds.push(row.instId)
}
writeFileSync(join(DIR, 'okx-instruments-SPOT-category-index.json'), JSON.stringify({
  note: 'OKX GET /api/v5/public/instruments?instType=SPOT 原始响应 1.2MB（1144 行），此处只落分类索引与样本；重跑探针可再取全量。',
  fetchedFrom: `${OKX_BASE}/api/v5/public/instruments?instType=SPOT`,
  httpStatus: spotRaw.status,
  total: spotRows.length,
  categories: spotCategories,
}, null, 2) + '\n')

/* 2) Binance：可达性核验（原始响应落档） */
const binanceProbes = []
for (const [label, url] of [
  ['spot-exchangeInfo', `${BINANCE_SPOT}/api/v3/exchangeInfo`],
  ['fapi-exchangeInfo', `${BINANCE_FAPI}/fapi/v1/exchangeInfo`],
  ['spot-ticker-24hr', `${BINANCE_SPOT}/api/v3/ticker/24hr?symbol=BTCUSDT`],
  ['fapi-ticker-24hr', `${BINANCE_FAPI}/fapi/v1/ticker/24hr?symbol=BTCUSDT`],
]) {
  const raw = await getRaw(url)
  binanceProbes.push({ label, url, httpStatus: raw.status, body: raw.text })
}
writeFileSync(join(DIR, 'binance-geo-block.json'), JSON.stringify(binanceProbes, null, 2) + '\n')

/* 3) 连接器解析真实响应（与原始响应同源） */
const okx = new OkxRestClient({ clockSync: false })
const roster = await okx.listInstruments()
const perp = roster.filter((i) => i.form === 'perp')
const spot = roster.filter((i) => i.form === 'spot')
const classCounts = {}
for (const item of perp) {
  const key = String(item.assetClass)
  classCounts[key] = (classCounts[key] ?? 0) + 1
}
const pick = (symbol) => roster.find((i) => i.symbol === symbol) ?? null
const formSymbolConsistent = roster.every((i) => i.symbol.endsWith('-SWAP') === (i.form === 'perp'))

let binanceVerdict
try {
  const instruments = await new BinanceRestClient({ timeoutMs: 15_000 }).listInstruments()
  binanceVerdict = { outcome: 'reachable', instruments: instruments.length }
} catch (error) {
  binanceVerdict = {
    outcome: 'blocked',
    isStructured: error instanceof BinanceError,
    code: error?.code ?? null,
    message: String(error?.message ?? error),
  }
}

let binancePerpTicker
try {
  binancePerpTicker = { outcome: 'reachable', ticker: await new BinanceRestClient({ timeoutMs: 15_000 }).getTicker('BTCUSDT-SWAP') }
} catch (error) {
  binancePerpTicker = {
    outcome: 'blocked',
    isStructured: error instanceof BinanceError,
    code: error?.code ?? null,
    message: String(error?.message ?? error),
  }
}

const summary = {
  fetchedAt: new Date().toISOString(),
  okx: {
    rosterTotal: roster.length,
    spotCount: spot.length,
    perpCount: perp.length,
    perpAssetClassCounts: classCounts,
    formSymbolConsistent,
    samples: {
      'BTCUSDT': pick('BTCUSDT'),
      'BTCUSDT-SWAP': pick('BTCUSDT-SWAP'),
      'TSLAUSDT-SWAP': pick('TSLAUSDT-SWAP'),
      'XAUUSDT-SWAP': pick('XAUUSDT-SWAP'),
      'SPXUSDT-SWAP': pick('SPXUSDT-SWAP'),
      'US500USDT-SWAP': pick('US500USDT-SWAP'),
    },
    spotCategoryCounts: Object.fromEntries(Object.entries(spotCategories).map(([k, v]) => [k, v.count])),
  },
  binance: { roster: binanceVerdict, perpTicker: binancePerpTicker },
}
console.log(JSON.stringify(summary, null, 2))
