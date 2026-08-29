/**
 * cn+hk 双市场真实网络验证（任务 H 交付证据）。
 * 运行：node spikes/impl-cn-hk/r3-real-network-verify.mjs（在仓库根目录）
 * 证据：spikes/impl-cn-hk/r3-verify-*.json
 */
import { TencentRestClient } from '../../packages/connector-tencent/lib/index.js'
import { writeFileSync } from 'node:fs'

const results = []
const cases = [
  { label: 'cn-moutai', market: 'cn', symbol: '600519', klinesLimit: 5 },
  { label: 'hk-tencent', market: 'hk', symbol: '700', klinesLimit: 5 },
]

for (const c of cases) {
  const client = new TencentRestClient(c.market)
  const ticker = await client.getTicker(c.symbol)
  const klines = await client.getKlines(c.symbol, '1d', c.klinesLimit)
  const record = {
    case: c,
    ticker,
    klineCount: klines.length,
    lastKline: klines[klines.length - 1],
    verifiedAt: new Date().toISOString(),
  }
  results.push(record)
  console.log(`=== ${c.label}: ${ticker.name} ${ticker.symbol} price=${ticker.price} vol=${ticker.volume} time=${new Date(ticker.timestamp).toISOString()} klines=${klines.length} last=${JSON.stringify(klines[klines.length - 1])}`)
  writeFileSync(`spikes/impl-cn-hk/r3-verify-${c.label}.json`, JSON.stringify(record, null, 2))
}

// 断言：价格/量为有限正数、名称非空且非乱码（GBK 契约）、K 线 OHLC 关系自洽。
for (const r of results) {
  const t = r.ticker
  if (!(t.price > 0) || !(t.volume > 0)) throw new Error(`${r.case.label}: ticker price/volume not positive`)
  if (!/^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(t.name)) throw new Error(`${r.case.label}: ticker name is mojibake: ${t.name}`)
  const k = r.lastKline
  if (!(k.high >= k.low && k.high >= k.open && k.high >= k.close && k.low <= k.open && k.low <= k.close)) {
    throw new Error(`${r.case.label}: kline OHLC inconsistent: ${JSON.stringify(k)}`)
  }
}
console.log(`REAL-NETWORK VERIFY PASS: ${results.length}/2 markets (GBK decode + field layout + kline order all checked)`)
