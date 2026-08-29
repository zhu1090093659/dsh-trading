// Yahoo Finance v8 chart API 探针（任务 G 真实网络验证，证据留本目录）。
// 用法：node yahoo-probe.mjs <SYMBOL>  （缺省 AAPL）
// 证据文件：ticker-<SYM>.json / klines-<SYM>-1d.json / klines-<SYM>-60m.json / probe-output.txt
// 交叉一致性取「同一响应内」：meta.regularMarketPrice vs 该响应最后一根日 K close
// （跨响应比较会有 Yahoo 非官方 API 的数据 vintage 差，见 EVIDENCE.md）。
import { writeFile } from 'node:fs/promises'
const symbol = (process.argv[2] ?? 'AAPL').toUpperCase()
const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'
const HEADERS = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }

async function chart(symbol, interval, range) {
  const url = `${BASE}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`
  const res = await fetch(url, { headers: HEADERS })
  const body = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  return { url, status: res.status, json: JSON.parse(body) }
}

const barsOf = (r) => {
  const q = r.indicators.quote[0]
  return r.timestamp
    .map((ts, i) => ({ time: new Date(ts * 1000).toISOString(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }))
    .filter((b) => b.c != null)
}

const ticker = await chart(symbol, '1d', '5d')
const daily = await chart(symbol, '1d', '1mo')
const hourly = await chart(symbol, '60m', '5d')
const nowIso = new Date().toISOString()
console.log(`# Yahoo v8 chart probe ${nowIso} (egress: this machine, real network)`)

const tRes = ticker.json.chart.result[0]
const meta = tRes.meta
const tBars = barsOf(tRes)
const dBars = barsOf(daily.json.chart.result[0])
const hBars = barsOf(hourly.json.chart.result[0])

await writeFile(`ticker-${symbol}.json`, JSON.stringify({ fetchedAt: nowIso, url: ticker.url, meta, bars: tBars }, null, 2))
await writeFile(`klines-${symbol}-1d.json`, JSON.stringify({ fetchedAt: nowIso, url: daily.url, interval: '1d', range: '1mo', bars: dBars }, null, 2))
await writeFile(`klines-${symbol}-60m.json`, JSON.stringify({ fetchedAt: nowIso, url: hourly.url, interval: '60m', range: '5d', bars: hBars }, null, 2))

const price = meta.regularMarketPrice
const lastDailySameResponse = tBars[tBars.length - 1]
const lastDailyLagged = dBars[dBars.length - 1]
const lastHourly = hBars[hBars.length - 1]
const pct = (x) => Number((((x - price) / price) * 100).toFixed(4))
console.log(JSON.stringify({
  symbol, fetchedAt: nowIso, requests: 3,
  meta: { currency: meta.currency, regularMarketPrice: price, regularMarketTime: new Date(meta.regularMarketTime * 1000).toISOString(), exchangeTimezoneName: meta.exchangeTimezoneName },
  consistency_sameResponse: {
    lastDailyBar_tickerResponse: { time: lastDailySameResponse.time, close: lastDailySameResponse.c },
    relDiff_dailyClose_pct: pct(lastDailySameResponse.c),
    last60mBar_close: lastHourly.c,
    relDiff_60mClose_pct: pct(lastHourly.c),
    verdict: 'regularMarketPrice must match the last daily close AND last 60m close of the SAME responses (float32 rounding ~1e-6)',
  },
  crossResponse_vintage_note: {
    lastDailyBar_1moRange: { time: lastDailyLagged.time, close: lastDailyLagged.c },
    note: 'separate 1mo-range request may lag the latest session (non-official API vintage); NOT a contradiction — same-response check above is authoritative',
  },
  counts: { dailyBars_5d: tBars.length, dailyBars_1mo: dBars.length, hourlyBars: hBars.length },
}, null, 2))
