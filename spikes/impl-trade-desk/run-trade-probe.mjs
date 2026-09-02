/**
 * 端到端交易台验证（issue #40）：真实 OkxTradeService（构建产物）→ TradingBridge →
 * /trade/* dispatch。
 * - POST /trade/order（dry-run 强制）：无需凭证——走 simulate 闸门 + okx 公共 ticker 参照。
 * - 只读面（positions/orders/fills/balances）：本出口无 OKX 凭证 → 证明 fail-closed
 *   结构化错误（TRADING_CREDENTIALS_MISSING），GUI 分区据此显示凭证提示而非空数据。
 * 运行前提：`pnpm build`。  node run-trade-probe.mjs
 */
const fakeCtx = { get: () => undefined, reflect: { provide: () => {} } }

const { OkxTradeService, OkxRestClient } = await import('../../packages/connector-okx/lib/index.js')
const { TradingBridge, createBridgeHost, dispatchBridgeRequest } = await import('../../packages/client-ui-trading/lib/bridge.js')

const config = {
  enabled: true, env: 'demo', dryRun: true, liveTrading: false,
  apiKeyRef: 'OKX_API_KEY', secretRef: 'OKX_SECRET_KEY', passphraseRef: 'OKX_PASSPHRASE',
  demoApiKeyRef: 'OKX_DEMO_API_KEY', demoSecretRef: 'OKX_DEMO_SECRET_KEY', demoPassphraseRef: 'OKX_DEMO_PASSPHRASE',
}

// resolveCredentials 走环境回退（本出口未设 → 只读面预期 CREDENTIALS_MISSING）。
const trade = new OkxTradeService(fakeCtx, {
  client: new OkxRestClient(),
  config,
  getCredentials: async () => {
    const error = new Error('OKX derivatives credentials missing (OKX_DEMO_* unresolved)')
    error.code = 'TRADING_CREDENTIALS_MISSING'
    throw error
  },
})
const bridge = new TradingBridge(createBridgeHost({
  tradeRegistry: { active: (market) => (market === 'crypto' ? { provider: 'okx', service: trade } : undefined) },
}))

async function get(endpoint) {
  try {
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', endpoint, new URLSearchParams({ market: 'crypto' }))
    return { endpoint, status, ok: payload?.ok === true, count: Array.isArray(payload?.positions ?? payload?.orders ?? payload?.fills ?? payload?.balances) ? (payload.positions ?? payload.orders ?? payload.fills ?? payload.balances).length : undefined }
  } catch (error) {
    // 宿主半（index.ts）对非协议错误的真实包裹：HTTP 200 + { ok:false, code, message }。
    return { endpoint, status: 200, ok: false, code: error?.code ?? 'TRADING_UNKNOWN', message: String(error?.message ?? error).slice(0, 80) }
  }
}

const out = {
  timestamp: new Date().toISOString(),
  note: '本出口无 OKX demo 凭证：只读面预期 fail-closed；dry-run 下单（模拟闸门 + 公共 ticker 参照）应真实成功。',
  dryRunOrder: await (async () => {
    const { status, payload } = await dispatchBridgeRequest(
      bridge, 'POST', '/trade/order', new URLSearchParams({ market: 'crypto' }),
      { symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'limit', quantity: 0.02, price: 40000 },
    )
    return { status, ok: payload?.ok === true, order: payload?.order }
  })(),
  readonlyFailClosed: {
    positions: await get('/trade/positions'),
    orders: await get('/trade/orders'),
    fills: await get('/trade/fills'),
    balances: await get('/trade/balances'),
  },
}

console.log(JSON.stringify(out, null, 2))
