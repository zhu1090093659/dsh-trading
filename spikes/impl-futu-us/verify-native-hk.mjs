
import { FutuRestClient } from '../../packages/connector-futu/lib/rest.js'
const c = new FutuRestClient({ gatewayUrl: 'http://127.0.0.1:11113' })
const out = []
out.push(['native HK.00700 ticker', JSON.stringify(await c.getTicker('HK.00700'))])
out.push(['canonical 00700.HK ticker', JSON.stringify(await c.getTicker('00700.HK'))])
out.push(['US.AAPL ticker', JSON.stringify(await c.getTicker('US.AAPL'))])
out.push(['bare AAPL 5m last', JSON.stringify((await c.getKlines('AAPL','5m',2)).at(-1))])
out.push(['HK.00700 5m last', JSON.stringify((await c.getKlines('HK.00700','5m',2)).at(-1))])
try { await c.placeOrder(undefined, { symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }) }
catch (e) { out.push(['US order gate', e.code + ': ' + e.message]) }
console.log('now=' + new Date().toISOString())
for (const [k,v] of out) console.log(k + ': ' + v)
