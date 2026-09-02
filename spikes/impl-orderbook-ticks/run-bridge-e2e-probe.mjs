/**
 * 端到端桥验证（issue #39）：真实连接器服务（构建产物，真网络）→ TradingBridge →
 * GET /orderbook + /trades dispatch。运行前提：`pnpm build`。
 */
const fakeCtx = { get: () => undefined, reflect: { provide: () => {} } }

const [{ BinanceMarketDataService }, { TencentMarketDataService }, bridgeMod] = await Promise.all([
  import('../../packages/connector-binance/lib/index.js'),
  import('../../packages/connector-tencent/lib/index.js'),
  import('../../packages/client-ui-trading/lib/bridge.js'),
])

const { TradingBridge, createBridgeHost, dispatchBridgeRequest } = bridgeMod

function bridgeFor(service) {
  return new TradingBridge(createBridgeHost({
    registry: { active: (market) => (market === service.market ? { provider: 'e2e', service: service.service } : undefined) },
  }))
}

async function probe(bridge, endpoint, params) {
  const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', endpoint, new URLSearchParams(params))
  return { status, ok: payload?.ok, summary: endpoint === '/orderbook'
    ? { symbol: payload?.orderbook?.symbol, bid1: payload?.orderbook?.bids?.[0] ?? null, ask1: payload?.orderbook?.asks?.[0] ?? null, levels: [payload?.orderbook?.bids?.length, payload?.orderbook?.asks?.length] }
    : { count: payload?.trades?.length, first: payload?.trades?.[0], last: payload?.trades?.[(payload?.trades?.length ?? 1) - 1] } }
}

const binance = { market: 'crypto', service: new BinanceMarketDataService(fakeCtx) }
const tencentCn = { market: 'cn', service: new TencentMarketDataService(fakeCtx, 'cn') }

const out = {
  timestamp: new Date().toISOString(),
  binance: {
    orderbook: await probe(bridgeFor(binance), '/orderbook', { market: 'crypto', symbol: 'BTCUSDT' }),
    trades: await probe(bridgeFor(binance), '/trades', { market: 'crypto', symbol: 'BTCUSDT', limit: '10' }),
  },
  tencentCn: {
    orderbook: await probe(bridgeFor(tencentCn), '/orderbook', { market: 'cn', symbol: '600519.SH' }),
  },
}

console.log(JSON.stringify(out, null, 2))
