import { FutuRestClient } from '/tmp/dsh-trading-futu-us/packages/connector-futu/lib/rest.js'
const c = new FutuRestClient({ gatewayUrl: 'http://127.0.0.1:11113' })
const lines = []
lines.push(['us.AAPL ticker', JSON.stringify(await c.getTicker('us.AAPL'))])
lines.push(['US.AAPL 1d last', JSON.stringify((await c.getKlines('US.AAPL', '1d', 2)).at(-1))])
lines.push(['US.AAPL 5m last', JSON.stringify((await c.getKlines('AAPL', '5m', 2)).at(-1))])
lines.push(['00700.HK ticker', JSON.stringify(await c.getTicker('00700.HK'))])
try { await c.placeOrder(undefined, { symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }) }
catch (e) { lines.push(['US placeOrder gate', `${e.code}: ${e.message}`]) }
for (const [k, v] of lines) console.log(`${k}: ${v}`)
