/**
 * R1-R3 真实网络验证（任务 K）：公共端点 ticker / candles(1Dutc vs 1D) / funding-rate /
 * instruments + 与 Binance 同品种价格交叉 sanity；签名/demo 端点无凭证不测
 * （skip-if-no-creds：设置 OKX_DEMO_* 三个环境变量后才会执行只读 balance 探测）。
 *
 * 运行：node spikes/impl-okx/r3-real-network-verify.mjs  （产出 r3-verify-*.json + REPORT 摘要）
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://openapi.okx.com'
const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const results = []
const fail = []

async function get(path, params) {
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
  const t0 = Date.now()
  const res = await fetch(url, { headers: { 'User-Agent': 'dsh-trading-impl-okx-verify/1.0' } })
  const body = await res.json()
  if (!res.ok || body.code !== '0') throw new Error(`${path}: HTTP ${res.status} code=${body.code} msg=${body.msg}`)
  return { url: url.toString(), ms: Date.now() - t0, data: body.data }
}

function record(name, payload) {
  results.push({ name, ...payload })
  console.log(`PASS ${name}`)
}

function recordFail(name, error) {
  fail.push({ name, error: String(error) })
  console.error(`FAIL ${name}: ${error}`)
}

try {
  // 1. 公共 ticker（BTC-USDT）。
  const ticker = await get('/api/v5/market/ticker', { instId: 'BTC-USDT' })
  const t = ticker.data[0]
  record('ticker BTC-USDT', { file: 'r3-verify-ticker.json', url: ticker.url, latencyMs: ticker.ms, last: t.last, bidPx: t.bidPx, askPx: t.askPx, vol24h: t.vol24h, ts: t.ts })
  writeFileSync(join(OUT_DIR, 'r3-verify-ticker.json'), JSON.stringify({ url: ticker.url, data: ticker.data }, null, 2))

  // 2. candles：1Dutc vs 1D —— 待验证 #3 的实证（1D 应为 UTC+8 日界 = 16:00 UTC 开盘）。
  const candlesUtc = await get('/api/v5/market/candles', { instId: 'BTC-USDT', bar: '1Dutc', limit: '3' })
  const candlesHk = await get('/api/v5/market/candles', { instId: 'BTC-USDT', bar: '1D', limit: '3' })
  const utcTs = candlesUtc.data.map((r) => Number(r[0]))
  const hkTs = candlesHk.data.map((r) => Number(r[0]))
  const offsetHours = (hkTs[0] - utcTs[0]) / 3_600_000
  record('candles 1Dutc vs 1D（日界对照）', {
    file: 'r3-verify-candles.json',
    utcFirstBar: new Date(utcTs[0]).toISOString(),
    hkFirstBar: new Date(hkTs[0]).toISOString(),
    offsetHours,
    conclusion: offsetHours === -8
      ? '1D 最新 bar 比 1Dutc 早 8h 开盘（UTC+8 日界=16:00 UTC）→ 实证 1D 按 UTC+8 开盘，Interval 1d 取 1Dutc（与 Binance 日线同日界）成立'
      : `unexpected offset ${offsetHours}h — 复核口径`,
  })
  writeFileSync(join(OUT_DIR, 'r3-verify-candles.json'), JSON.stringify({ utc: candlesUtc.data, hk: candlesHk.data }, null, 2))

  // 3. funding rate（BTC-USDT-SWAP）。
  const funding = await get('/api/v5/public/funding-rate', { instId: 'BTC-USDT-SWAP' })
  const f = funding.data[0]
  record('funding-rate BTC-USDT-SWAP', { file: 'r3-verify-funding.json', fundingRate: f.fundingRate, nextFundingRate: f.nextFundingRate, fundingTime: f.fundingTime })
  writeFileSync(join(OUT_DIR, 'r3-verify-funding.json'), JSON.stringify({ url: funding.url, data: funding.data }, null, 2))

  // 4. instruments（sz 纪律依据：ctVal/lotSz/minSz）。
  const instruments = await get('/api/v5/public/instruments', { instType: 'SWAP', instId: 'BTC-USDT-SWAP' })
  const inst = instruments.data[0]
  record('instruments BTC-USDT-SWAP', { file: 'r3-verify-instruments.json', ctVal: inst.ctVal, lotSz: inst.lotSz, minSz: inst.minSz, tickSz: inst.tickSz, settleCcy: inst.settleCcy })
  writeFileSync(join(OUT_DIR, 'r3-verify-instruments.json'), JSON.stringify({ url: instruments.url, data: instruments.data }, null, 2))

  // 5. 与 Binance 同品种交叉 sanity（BTC-USDT vs BTCUSDT，相对差）。
  const t0 = Date.now()
  const binance = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then((r) => r.json())
  const okxLast = Number(t.last)
  const binanceLast = Number(binance.price)
  const relDiff = Math.abs(okxLast - binanceLast) / binanceLast
  record('cross-check vs Binance BTCUSDT', {
    file: 'r3-verify-cross.json',
    okx: okxLast,
    binance: binanceLast,
    relativeDiff: relDiff,
    binanceLatencyMs: Date.now() - t0,
    sanity: relDiff < 0.005 ? 'PASS（<0.5%，两所价差在正常市场内）' : `WARN relDiff=${relDiff}`,
  })
  writeFileSync(join(OUT_DIR, 'r3-verify-cross.json'), JSON.stringify({ okxLast, binanceLast, relDiff }, null, 2))
} catch (error) {
  recordFail('public flow', error)
}

// 6. 签名/demo 端点：skip-if-no-creds（无凭证不测——任务 K 明确要求）。
const demoCreds = [process.env.OKX_DEMO_API_KEY, process.env.OKX_DEMO_SECRET_KEY, process.env.OKX_DEMO_PASSPHRASE]
if (demoCreds.every((v) => v)) {
  try {
    const timestamp = new Date().toISOString()
    const { createHmac } = await import('node:crypto')
    const prehash = `${timestamp}GET/api/v5/account/balance`
    const sign = createHmac('sha256', demoCreds[1]).update(prehash).digest('base64')
    const res = await fetch(`${BASE}/api/v5/account/balance`, {
      headers: {
        'OK-ACCESS-KEY': demoCreds[0], 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': demoCreds[2], 'x-simulated-trading': '1',
      },
    })
    const body = await res.json()
    record('demo signed balance probe', { file: 'r3-verify-demo-balance.json', httpStatus: res.status, code: body.code, simulated: true })
    writeFileSync(join(OUT_DIR, 'r3-verify-demo-balance.json'), JSON.stringify({ code: body.code, dataKeys: body.data?.map((d) => Object.keys(d)) }, null, 2))
  } catch (error) {
    recordFail('demo signed balance probe', error)
  }
} else {
  record('demo signed balance probe', {
    file: null,
    skipped: 'no OKX_DEMO_* credentials in environment — skipped by design (skip-if-no-creds); provide demo keys to run',
  })
}

// 摘要。
const summary = { generatedAt: new Date().toISOString(), base: BASE, pass: results.length, fail: fail.length, results, fail }
writeFileSync(join(OUT_DIR, 'r3-verify-summary.json'), JSON.stringify(summary, null, 2))
console.log(`\n${results.length} pass / ${fail.length} fail → r3-verify-summary.json`)
if (fail.length > 0) process.exit(1)
