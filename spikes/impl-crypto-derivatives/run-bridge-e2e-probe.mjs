/**
 * 端到端桥验证（issue #38）：真实 BinanceMarketDataService（构建产物，真网络）
 * → TradingBridge（registry-first 解析）→ GET /derivatives dispatch。
 * 运行前提：`pnpm build`。  node run-bridge-e2e-probe.mjs
 */
const fakeCtx = { get: () => undefined, reflect: { provide: () => {} } }

const [{ BinanceMarketDataService }, { BybitMarketDataService }, { OkxMarketDataService }, bridgeMod] = await Promise.all([
  import('../../packages/connector-binance/lib/index.js'),
  import('../../packages/connector-bybit/lib/index.js'),
  import('../../packages/connector-okx/lib/index.js'),
  import('../../packages/client-ui-trading/lib/bridge.js'),
])

const { TradingBridge, createBridgeHost, dispatchBridgeRequest } = bridgeMod

async function probe(label, service, market, symbol) {
  const bridge = new TradingBridge(createBridgeHost({
    registry: { active: (m) => (m === market ? { provider: 'e2e', service } : undefined) },
  }))
  const search = new URLSearchParams({ market, symbol })
  const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/derivatives', search)
  return { label, status, payload }
}

const out = {
  timestamp: new Date().toISOString(),
  binance: await probe('binance BTCUSDT', new BinanceMarketDataService(fakeCtx), 'crypto', 'BTCUSDT'),
  okx: await probe('okx BTCUSDT', new OkxMarketDataService(fakeCtx), 'crypto', 'BTCUSDT'),
  bybit: await probe('bybit BTCUSDT', new BybitMarketDataService(fakeCtx), 'crypto', 'BTCUSDT'),
}

console.log(JSON.stringify(out, null, 2))
