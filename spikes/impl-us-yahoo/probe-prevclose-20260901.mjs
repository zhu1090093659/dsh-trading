// 真实网络验证（2026-09-01，修复后构建产物）：AAPL 昨收锚点应 = 319.7（富途同值）
import { YahooRestClient } from '/Users/zcl/code/dsh-trading/packages/connector-yahoo/lib/index.js'

const client = new YahooRestClient()
const ticker = await client.getTicker('AAPL')
console.log('getTicker(AAPL) =', JSON.stringify(ticker, null, 2))
console.log('change check =', (ticker.price - ticker.prevClose).toFixed(3), '/', ticker.changePercent?.toFixed(3) + '%')

const klines = await client.getKlines('AAPL', '1d')
console.log('\ngetKlines(AAPL,1d) tail 4 (documenting the daily-series vintage gap):')
for (const k of klines.slice(-4)) {
  console.log(' ', new Date(k.openTime).toISOString().slice(0, 10), 'close', k.close)
}
