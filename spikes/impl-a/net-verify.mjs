// 任务 A 真实网络验证：经构建产物 lib/rest.js 调 api.binance.com 公共 REST（无凭证）。
// 运行：node spikes/impl-a/net-verify.mjs
import { BinanceRestClient } from '/Users/zcl/code/dsh-trading/packages/connector-binance/lib/rest.js'

const client = new BinanceRestClient() // 默认 https://api.binance.com，10s 超时，全局 fetch

const started = Date.now()
const ticker = await client.getTicker('BTCUSDT')
console.log('[1] getTicker BTCUSDT ->', JSON.stringify(ticker))

const klines = await client.getKlines('BTCUSDT', '1h', 3)
console.log('[2] getKlines BTCUSDT 1h x3 ->', JSON.stringify(klines))

const symbol = ticker.symbol
const price = ticker.price
const first = klines[0]
console.log(
  `[ok] symbol=${symbol} price=${price} klines=${klines.length} firstOpen=${first.open} elapsed=${Date.now() - started}ms`,
)
