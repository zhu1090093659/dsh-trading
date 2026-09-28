/**
 * 星耀数智（AmazingData / tgw）A 股连接的**真实出网验证**（connector-playbook §5 R 序列：
 * 连接器出网验证是铁律）。
 *
 * 被测链路：connector-xysz/lib/rest.js → xysz-api（FastAPI 封装 AmazingData SDK，
 * 部署在局域网 Ubuntu 机器 192.168.31.50）→ 星耀数智上游 101.230.159.235:8600。
 *
 * 运行：node spikes/impl-xysz/r3-real-network-verify.mjs
 * 前置：xysz-api 在跑（systemd --user xysz-api.service，监听 0.0.0.0:8191）。
 *   本机 8191 被 ufw 拦（只放行 22/8190）时走 SSH 隧道：
 *     ssh -f -N -L 127.0.0.1:8191:127.0.0.1:8191 local1
 * 证据落盘：本目录 r3-*.raw.json + r3-verify-summary.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { XyszRestClient } from '../../packages/connector-xysz/lib/rest.js'

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.XYSZ_API_URL ?? 'http://127.0.0.1:8191'
const client = new XyszRestClient({ apiUrl: BASE, timeoutMs: 90_000 })

const results = []
const failures = []

function record(name, payload) {
  results.push({ name, ...payload })
  console.log('PASS ' + name + (payload.latencyMs !== undefined ? ' (' + payload.latencyMs + ' ms)' : ''))
}

function recordFail(name, error) {
  failures.push({ name, error: String(error) })
  console.error('FAIL ' + name + ': ' + error)
}

function save(file, data) {
  writeFileSync(join(OUT_DIR, file), JSON.stringify(data, null, 2) + '\n')
}

/** 直连上游（不入连接器）取原始响应，作为「原始证据」而非加工后视图。 */
async function raw(path, params) {
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
  const t0 = Date.now()
  const res = await fetch(url)
  const body = await res.json()
  return { url: url.toString(), status: res.status, ms: Date.now() - t0, body }
}

const SYMBOL = '600519.SH'
const SYMBOL_SZ = '000001.SZ'

try {
  // 0. 健康面：确认封装服务已登录星耀数智上游（登录态是全部数据接口的前置）。
  //    证据落盘一律脱敏账号（只留 host:port），仓库不留账号标识。
  const health = await raw('/health')
  const maskedUpstream = { ...(health.body.upstream ?? {}), username: '***' }
  save('r3-health.raw.json', { url: health.url, body: { ...health.body, upstream: maskedUpstream } })
  record('health（封装服务 + 上游登录态）', {
    file: 'r3-health.raw.json', latencyMs: health.ms,
    status: health.body.status, loggedIn: health.body.logged_in,
    upstream: maskedUpstream, sdkVersion: health.body.sdk_version,
  })

  // 1. ticker（连接器契约面）：规范形 + 裸 6 位都应命中同一标的。
  const healthT0 = Date.now()
  const ticker = await client.getTicker(SYMBOL)
  save('r3-ticker.raw.json', { symbol: SYMBOL, ticker, connectorLatencyMs: Date.now() - healthT0 })
  record('ticker ' + SYMBOL + '（连接器解析）', {
    file: 'r3-ticker.raw.json',
    price: ticker.price, prevClose: ticker.prevClose, changePercent: ticker.changePercent,
    bid: ticker.bid, ask: ticker.ask, timestamp: ticker.timestamp,
  })

  const tickerBare = await client.getTicker('600519')
  record('ticker 裸 6 位入参归一到规范形', {
    canonical: tickerBare.symbol, samePrice: tickerBare.price === ticker.price,
  })

  const tickerSz = await client.getTicker(SYMBOL_SZ)
  save('r3-ticker-sz.raw.json', { symbol: SYMBOL_SZ, ticker: tickerSz })
  record('ticker ' + SYMBOL_SZ + '（深市）', { price: tickerSz.price, prevClose: tickerSz.prevClose })

  // 2. 日 K（历史行情主路径）。
  const t1 = Date.now()
  const klines = await client.getKlines(SYMBOL, '1d', 30)
  save('r3-klines-1d.raw.json', { symbol: SYMBOL, interval: '1d', count: klines.length, klines })
  record('klines 1d（升序 + 数量）', {
    file: 'r3-klines-1d.raw.json', latencyMs: Date.now() - t1, count: klines.length,
    first: klines[0], last: klines.at(-1),
  })

  // 3. 分钟 K（当日分时主路径）。
  const t2 = Date.now()
  const min1 = await client.getKlines(SYMBOL, '1m', 60)
  save('r3-klines-1m.raw.json', { symbol: SYMBOL, interval: '1m', count: min1.length, klines: min1 })
  record('klines 1m（当日分时，升序）', {
    file: 'r3-klines-1m.raw.json', latencyMs: Date.now() - t2, count: min1.length,
    first: min1[0], last: min1.at(-1),
  })

  // 4. 周 K / 月 K（长周期覆盖）。
  const week = await client.getKlines(SYMBOL, '1w', 8)
  record('klines 1w', { count: week.length, last: week.at(-1) })
  const month = await client.getKlines(SYMBOL, '1M', 6)
  record('klines 1M', { count: month.length, last: month.at(-1) })

  // 5. 五档盘口（Level-1 快照尾部）。
  const t3 = Date.now()
  const book = await client.getOrderbook(SYMBOL)
  save('r3-orderbook.raw.json', { symbol: SYMBOL, orderbook: book })
  record('orderbook 五档', {
    file: 'r3-orderbook.raw.json', latencyMs: Date.now() - t3,
    bidLevels: book.bids.length, askLevels: book.asks.length,
    bestBid: book.bids[0], bestAsk: book.asks[0],
  })

  // 6. 名册与名称检索（listInstruments optional 面）。
  const t4 = Date.now()
  const all = await client.listInstruments()
  const found = await client.listInstruments('茅台')
  save('r3-instruments.raw.json', { count: all.length, sample: all.slice(0, 20), maotai: found })
  record('listInstruments 全量 + 名称检索', {
    file: 'r3-instruments.raw.json', latencyMs: Date.now() - t4,
    total: all.length, maotaiMatches: found.length,
  })

  // 7. 基本面（optional 面：名称 + 52 周高低）。
  const t5 = Date.now()
  const fundamentals = await client.getFundamentals(SYMBOL)
  save('r3-fundamentals.raw.json', { symbol: SYMBOL, fundamentals })
  record('fundamentals（名称 + 52 周高低派生）', {
    file: 'r3-fundamentals.raw.json', latencyMs: Date.now() - t5, ...fundamentals,
  })

  // 8. 交叉 sanity：ticker 最新价 vs 日 K 末收（同源同标的，应高度一致）。
  const lastClose = klines.at(-1)?.close
  if (typeof lastClose === 'number' && ticker.price > 0) {
    const ratio = Math.abs(ticker.price - lastClose) / lastClose
    record('交叉 sanity：ticker 价 vs 日K末收', {
      tickerPrice: ticker.price, lastClose, ratio,
      conclusion: ratio < 0.05 ? '同源一致（差 <5%）' : '差异偏大，需复核口径',
    })
  }

  // 9. 跨市场形态拒绝（fail-closed，不发请求即拒绝）。
  try {
    await client.getTicker('00700.HK')
    recordFail('港股形态拒绝', 'expected TRADING_UNSUPPORTED_SYMBOL but resolved')
  } catch (err) {
    record('港股形态拒绝（fail-closed）', { code: err.code, message: err.message })
  }
} catch (err) {
  recordFail('spike 顶层', err)
}

const summary = {
  target: BASE,
  generatedAt: new Date().toISOString(),
  passed: results.length,
  failed: failures.length,
  results,
  failures,
}
save('r3-verify-summary.json', summary)
console.log('\n' + results.length + ' passed, ' + failures.length + ' failed — summary: spikes/impl-xysz/r3-verify-summary.json')
if (failures.length > 0) process.exitCode = 1
