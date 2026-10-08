/**
 * 加密永续名册真值复验探针（可达环境，只读公共端点）。
 *
 * 背景：本机默认出口是地域受限节点 —— Binance api/fapi 全量 HTTP 451、Bybit 全量 HTTP 403
 * （原始捕获见本目录 binance-geo-block.json 与 bybit-egress-blocked-*.json|headers）。
 * 把出口切到可达地域（本机为 clash/mihomo 的 SG/JP/HK/TW/DE/KR/GB 节点）后运行本探针，
 * 即拿到**真实上游响应**与连接器解析结果，把 P2/P3 的 blocked 项转正。
 *
 * 用法（可达出口）：
 *   node_modules/.bin/tsx spikes/impl-crypto-perp-tradfi/run-reverify-probe.ts
 *
 * 产物（同目录）：
 *   binance-usdm-exchangeInfo.json      Binance USDT-M 名册全量原始响应
 *   binance-spot-exchangeInfo-index.json 现货名册 17MB 不落全量，只落计数/状态分布/样本
 *   bybit-linear-instruments.json       Bybit 线性名册全量原始响应（单页，游标为空）
 *   bybit-spot-instruments.json         Bybit 现货名册全量原始响应
 *   binance-usdm-ticker-*.json / bybit-linear-ticker-*.json / *-kline-*.json  行情原始响应
 *   reverify-summary.json               连接器解析 + 请求 URL 轨迹 + 出口 IP + HEAD sha + 断言结果
 *
 * 断言（不满足即退出码 1）：探针是判据，不是只读记录器。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BinanceRestClient } from '../../packages/connector-binance/src/rest.ts'
import { BybitRestClient } from '../../packages/connector-bybit/src/rest.ts'

const DIR = dirname(fileURLToPath(import.meta.url))
mkdirSync(DIR, { recursive: true })

const BINANCE_SPOT = 'https://api.binance.com'
const BINANCE_FAPI = 'https://fapi.binance.com'
const BYBIT = 'https://api.bybit.com'

const failures: string[] = []
function check(label: string, condition: boolean): void {
  if (!condition) failures.push(label)
  console.log('[' + (condition ? 'PASS' : 'FAIL') + '] ' + label)
}

const trace: string[] = []
/** 记录 URL 后委托全局 fetch：URL 轨迹用于证明形态分流真的打到了合约端点。 */
const tracedFetch = (async (input: unknown, init?: unknown) => {
  trace.push(String(input))
  return globalThis.fetch(input as string, init as RequestInit)
}) as typeof fetch

async function getRaw(url: string): Promise<{ status: number; text: string }> {
  const res = await globalThis.fetch(url)
  return { status: res.status, text: await res.text() }
}

const stamp = new Date().toISOString()
let egress = 'unknown'
try {
  const ip = await globalThis.fetch('https://api.ipify.org')
  egress = (await ip.text()).trim()
} catch { /* 出口 IP 只做标注，取不到不判红 */ }

/* 1) 原始响应落档 */
const binanceFutures = await getRaw(BINANCE_FAPI + '/fapi/v1/exchangeInfo')
if (binanceFutures.status === 200) writeFileSync(join(DIR, 'binance-usdm-exchangeInfo.json'), binanceFutures.text + '\n')
const binanceSpot = await getRaw(BINANCE_SPOT + '/api/v3/exchangeInfo')
if (binanceSpot.status === 200) {
  const rows = (JSON.parse(binanceSpot.text).symbols ?? []) as Array<Record<string, unknown>>
  const status: Record<string, number> = {}
  for (const row of rows) status[String(row.status)] = (status[String(row.status)] ?? 0) + 1
  writeFileSync(join(DIR, 'binance-spot-exchangeInfo-index.json'), JSON.stringify({
    note: '现货名册原始响应约 17MB，不落全量；此处落计数、状态分布与样本。全量可重跑探针再取。',
    fetchedAt: stamp,
    fetchedFrom: BINANCE_SPOT + '/api/v3/exchangeInfo',
    httpStatus: binanceSpot.status,
    total: rows.length,
    statusCounts: status,
    samples: rows.slice(0, 5).map((row) => ({ symbol: row.symbol, status: row.status, baseAsset: row.baseAsset, quoteAsset: row.quoteAsset })),
  }, null, 2) + '\n')
}
const bybitLinear = await getRaw(BYBIT + '/v5/market/instruments-info?category=linear&limit=1000')
if (bybitLinear.status === 200) writeFileSync(join(DIR, 'bybit-linear-instruments.json'), bybitLinear.text + '\n')
const bybitSpot = await getRaw(BYBIT + '/v5/market/instruments-info?category=spot&limit=1000')
if (bybitSpot.status === 200) writeFileSync(join(DIR, 'bybit-spot-instruments.json'), bybitSpot.text + '\n')

const captures: Array<[string, string]> = [
  ['binance-usdm-ticker-BTCUSDT', BINANCE_FAPI + '/fapi/v1/ticker/24hr?symbol=BTCUSDT'],
  ['binance-usdm-ticker-TSLAUSDT', BINANCE_FAPI + '/fapi/v1/ticker/24hr?symbol=TSLAUSDT'],
  ['binance-usdm-klines-BTCUSDT', BINANCE_FAPI + '/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=3'],
  ['bybit-linear-ticker-BTCUSDT', BYBIT + '/v5/market/tickers?category=linear&symbol=BTCUSDT'],
  ['bybit-linear-ticker-TSLAUSDT', BYBIT + '/v5/market/tickers?category=linear&symbol=TSLAUSDT'],
  ['bybit-linear-kline-BTCUSDT', BYBIT + '/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=3'],
]
const captureStatus: Record<string, number> = {}
for (const pair of captures) {
  const raw = await getRaw(pair[1])
  captureStatus[pair[0]] = raw.status
  writeFileSync(join(DIR, pair[0] + '.json'), raw.text + '\n')
}

/* 2) 连接器解析真实响应（与原始响应同源） */
const binance = new BinanceRestClient({ timeoutMs: 30_000, fetchImpl: tracedFetch })
const binanceRoster = await binance.listInstruments()
const binancePerp = binanceRoster.filter((i) => i.form === 'perp')
const binanceSpotCount = binanceRoster.filter((i) => i.form === 'spot').length
const binanceByClass: Record<string, number> = {}
for (const item of binancePerp) binanceByClass[String(item.assetClass)] = (binanceByClass[String(item.assetClass)] ?? 0) + 1
const binancePick = (symbol: string) => binanceRoster.find((i) => i.symbol === symbol) ?? null
const binancePerpTicker = await binance.getTicker('BTCUSDT-SWAP')
const binanceTradFiTicker = await binance.getTicker('TSLAUSDT-SWAP')

const bybit = new BybitRestClient({ fetchImpl: tracedFetch })
const bybitRoster = await bybit.listInstruments()
const bybitPerp = bybitRoster.filter((i) => i.form === 'perp')
const bybitByClass: Record<string, number> = {}
for (const item of bybitPerp) bybitByClass[String(item.assetClass)] = (bybitByClass[String(item.assetClass)] ?? 0) + 1
const bybitPick = (symbol: string) => bybitRoster.find((i) => i.symbol === symbol) ?? null
const bybitTradFiTicker = await bybit.getTicker('TSLAUSDT-SWAP')

/* 3) 判据（与卡级验收逐条对应） */
check('Binance 名册含 BTCUSDT-SWAP 且 form=perp', binancePick('BTCUSDT-SWAP')?.form === 'perp')
check('Binance 名册包含 TradFi 永续（TSLAUSDT-SWAP 存在）', binancePick('TSLAUSDT-SWAP') !== null)
check('Binance TSLAUSDT-SWAP.assetClass=equity（交易所 EQUITY/TradFi）', binancePick('TSLAUSDT-SWAP')?.assetClass === 'equity')
check('Binance HK/KR/CN 股票字面量均归 equity', ['TENCENTUSDT-SWAP', 'SAMSUNGUSDT-SWAP', 'CXMTUSDT-SWAP'].every((s) => binancePick(s)?.assetClass === 'equity'))
check('Binance SPXUSDT-SWAP 不得判为指数（SPX6900 是迷因币 => crypto）', binancePick('SPXUSDT-SWAP')?.assetClass === 'crypto')
check('Binance FX（USDBRLUSDT-SWAP）无枚举成员 => assetClass 留空', binancePick('USDBRLUSDT-SWAP') !== null && binancePick('USDBRLUSDT-SWAP')?.assetClass === undefined)
check('Binance 名册 form 与符号后缀一致', binanceRoster.every((i) => i.symbol.endsWith('-SWAP') === (i.form === 'perp')))
check('Binance 合约名册无 contractSize => contract 不出现 multiplier', binancePerp.every((i) => i.contract === undefined || i.contract.multiplier === undefined))
const bnPerpTickerUrl = trace.find((u) => u.includes('/ticker/24hr') && u.includes('BTCUSDT')) ?? ''
check('Binance 永续 ticker 打 fapi.binance.com/fapi/v1（非 api/v3）', bnPerpTickerUrl.includes('fapi.binance.com/fapi/v1/ticker/24hr') && !bnPerpTickerUrl.includes('api.binance.com'))
check('Binance 永续 ticker 返回真实价（BTCUSDT-SWAP last>1000）', Number(binancePerpTicker.last) > 1000)
check('Binance TradFi 永续 ticker 返回真实价（TSLAUSDT-SWAP 100<last<1000）', Number(binanceTradFiTicker.last) > 100 && Number(binanceTradFiTicker.last) < 1000)

check('Bybit 名册含 TSLAUSDT-SWAP（线性合约）', bybitPick('TSLAUSDT-SWAP')?.form === 'perp')
check('Bybit TSLAUSDT-SWAP.assetClass=equity（交易所 symbolType=stock）', bybitPick('TSLAUSDT-SWAP')?.assetClass === 'equity')
check('Bybit XAUUSDT-SWAP.assetClass=commodity（symbolType=commodity）', bybitPick('XAUUSDT-SWAP')?.assetClass === 'commodity')
check('Bybit 空 symbolType 的标准加密行留空（不推断成 crypto）', bybitPick('BTCUSDT-SWAP') !== null && bybitPick('BTCUSDT-SWAP')?.assetClass === undefined)
check('Bybit 名册 form 与符号后缀一致', bybitRoster.every((i) => i.symbol.endsWith('-SWAP') === (i.form === 'perp')))
const byTickerUrl = trace.find((u) => u.includes('/v5/market/tickers') && u.includes('TSLAUSDT')) ?? ''
check('Bybit TSLAUSDT-SWAP ticker 只打 category=linear（无 category=spot）', byTickerUrl.includes('category=linear') && !trace.some((u) => u.includes('/v5/market/tickers') && u.includes('category=spot')))
check('Bybit 线性 ticker 返回真实价（TSLAUSDT-SWAP 100<last<1000）', Number(bybitTradFiTicker.last) > 100 && Number(bybitTradFiTicker.last) < 1000)

const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DIR, encoding: 'utf8' }).trim()
const summary = {
  fetchedAt: stamp,
  egressIp: egress,
  headSha,
  upstreamStatus: {
    binanceUsdmExchangeInfo: binanceFutures.status,
    binanceSpotExchangeInfo: binanceSpot.status,
    bybitLinearInstruments: bybitLinear.status,
    bybitSpotInstruments: bybitSpot.status,
    tickers: captureStatus,
  },
  binance: {
    rosterTotal: binanceRoster.length,
    spotCount: binanceSpotCount,
    perpCount: binancePerp.length,
    perpAssetClassCounts: binanceByClass,
    samples: {
      'BTCUSDT-SWAP': binancePick('BTCUSDT-SWAP'),
      'TSLAUSDT-SWAP': binancePick('TSLAUSDT-SWAP'),
      'XAUUSDT-SWAP': binancePick('XAUUSDT-SWAP'),
      'USDBRLUSDT-SWAP': binancePick('USDBRLUSDT-SWAP'),
      'SPXUSDT-SWAP': binancePick('SPXUSDT-SWAP'),
    },
    perpTicker: binancePerpTicker,
    tradFiTicker: binanceTradFiTicker,
  },
  bybit: {
    rosterTotal: bybitRoster.length,
    perpCount: bybitPerp.length,
    perpAssetClassCounts: bybitByClass,
    samples: {
      'BTCUSDT-SWAP': bybitPick('BTCUSDT-SWAP'),
      'TSLAUSDT-SWAP': bybitPick('TSLAUSDT-SWAP'),
      'XAUUSDT-SWAP': bybitPick('XAUUSDT-SWAP'),
    },
    tradFiTicker: bybitTradFiTicker,
  },
  requestTrail: trace,
  failures,
}
writeFileSync(join(DIR, 'reverify-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ...summary, requestTrail: trace.length + ' urls' }, null, 2))
if (failures.length > 0) process.exit(1)
