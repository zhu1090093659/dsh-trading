/**
 * 交易面单测（离线）：三态闸门矩阵、三 ref 凭证缺失路径、sz 单位纪律（SPOT tgtCcy /
 * SWAP 张换算）、撤单幂等化、订单/持仓/余额解析。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/index.js'
import {
  OkxTradeService,
  type PlaceOrderArgs,
  buildDryRunReceipt,
  createPlaceOrderTool,
  credentialRefsFor,
  evaluateOrderGate,
  mapOrderState,
  resolveCredentials,
  type CredentialResolverLike,
} from '../src/index.js'
import { OkxRestClient, TradingServiceError, type OkxCredentials } from '../src/rest.js'

/* ------------------------------------------------------------------ */
/* 夹具                                                                    */
/* ------------------------------------------------------------------ */

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    env: 'demo',
    dryRun: true,
    liveTrading: false,
    apiKeyRef: 'OKX_API_KEY',
    secretRef: 'OKX_SECRET_KEY',
    passphraseRef: 'OKX_PASSPHRASE',
    demoApiKeyRef: 'OKX_DEMO_API_KEY',
    demoSecretRef: 'OKX_DEMO_SECRET_KEY',
    demoPassphraseRef: 'OKX_DEMO_PASSPHRASE',
    ...overrides,
  }
}

const MARKET_ARGS: PlaceOrderArgs = { instId: 'btc-usdt', side: 'buy', type: 'market', quantity: 0.01 }

/* ------------------------------------------------------------------ */
/* 三态闸门矩阵（主 agent 裁决 #2）                                          */
/* ------------------------------------------------------------------ */

describe('evaluateOrderGate（三态环境 × 三段闸门）', () => {
  it('① dryRun=false + liveTrading=false → 结构化拒绝（headless 唯一防线）', () => {
    const verdict = evaluateOrderGate(baseConfig(), { ...MARKET_ARGS, dryRun: false })
    expect(verdict).toMatchObject({ action: 'reject', code: 'TRADING_LIVE_TRADING_DISABLED' })
  })

  it('② dryRun=true（显式/缺省）→ simulate；env 不影响模拟路径', () => {
    expect(evaluateOrderGate(baseConfig(), MARKET_ARGS)).toEqual({ action: 'simulate' })
    expect(evaluateOrderGate(baseConfig({ env: 'live' }), MARKET_ARGS)).toEqual({ action: 'simulate' })
  })

  it('② config.dryRun=true 强制模拟：liveTrading=true 也不放行（拒绝语义优先于强制模拟）', () => {
    const verdict = evaluateOrderGate(baseConfig({ dryRun: true, liveTrading: true }), { ...MARKET_ARGS, dryRun: false })
    expect(verdict).toEqual({ action: 'simulate' })
  })

  it('③ dryRun=false + liveTrading=true + env=demo（缺省）→ live demo（真实签名打模拟盘）', () => {
    const verdict = evaluateOrderGate(baseConfig({ dryRun: false, liveTrading: true }), { ...MARKET_ARGS, dryRun: false })
    expect(verdict).toEqual({ action: 'live', environment: 'demo' })
  })

  it("③ env='live' → 实盘（第二次显式解锁；demo/live key 不通用）", () => {
    const verdict = evaluateOrderGate(baseConfig({ dryRun: false, liveTrading: true, env: 'live' }), { ...MARKET_ARGS, dryRun: false })
    expect(verdict).toEqual({ action: 'live', environment: 'live' })
  })
})

/* ------------------------------------------------------------------ */
/* 服务缝闸门（P0）：绕过工具层直调 TradeService 也 fail-closed                */
/* ------------------------------------------------------------------ */

describe('OkxTradeService 服务缝闸门（绕过工具层直调）', () => {
  it('① liveTrading=false（缺省）+ dryRun=false 直调 → TRADING_LIVE_TRADING_DISABLED，不触网', async () => {
    const { fetchImpl, posts } = routeFetch([])
    const trade = makeTradeService(fetchImpl, { liveTrading: false })
    await expect(trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01, dryRun: false }))
      .rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
    expect(posts).toHaveLength(0)
  })

  it('② dryRun 缺省直调 → 本地模拟回执（dryRun=true），不触网', async () => {
    const { fetchImpl, posts } = routeFetch([])
    const trade = makeTradeService(fetchImpl)
    const order = await trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01 })
    expect(order.dryRun).toBe(true)
    expect(order.status).toBe('filled')
    expect(posts).toHaveLength(0)
  })

  it('② config.dryRun=true 强制模拟：liveTrading=true + dryRun=false 直调也回模拟回执', async () => {
    const { fetchImpl, posts } = routeFetch([])
    const trade = makeTradeService(fetchImpl, { dryRun: true, liveTrading: true })
    const order = await trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01, dryRun: false })
    expect(order.dryRun).toBe(true)
    expect(posts).toHaveLength(0)
  })

  it('③ liveTrading=true + dryRun=false 直调 → 走真实签名路径（打到 mock 交易所）', async () => {
    const { fetchImpl, posts } = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SPOT_INSTRUMENT]) },
      { match: (u) => u.includes('/api/v5/trade/order'), respond: () => okEnvelope([{ ordId: 'seam-1', sCode: '0', sMsg: '' }]) },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    const order = await trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01, dryRun: false })
    expect(order.dryRun).toBe(false)
    expect(order.id).toBe('seam-1')
    expect(posts).toHaveLength(1)
  })

  it('撤单：liveTrading=false（缺省）直调 → TRADING_LIVE_TRADING_DISABLED（撤单与下单同门槛）', async () => {
    const { fetchImpl, posts } = routeFetch([])
    const trade = makeTradeService(fetchImpl)
    await expect(trade.cancelOrder('12345', 'BTC-USDT')).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
    expect(posts).toHaveLength(0)
  })
})

describe('crypto_place_order execute（闸门 × 工具层）', () => {
  const TICKER = { symbol: 'BTC-USDT', price: 42000.5, timestamp: 1_700_000_000_000 }

  function makeTool(configOverrides: Partial<Config> = {}) {
    const config = baseConfig(configOverrides)
    const getTicker = vi.fn(async () => TICKER)
    const placeOrder = vi.fn(async (req: { dryRun?: boolean }) => ({
      id: 'ord-1', symbol: req.symbol ?? 'BTC-USDT', side: 'buy' as const, type: 'market' as const,
      status: 'filled' as const, quantity: 0.01, dryRun: req.dryRun !== false, timestamp: 1,
    }))
    const tool = createPlaceOrderTool({ marketData: { getTicker }, trade: { placeOrder } as never, config })
    return { tool, getTicker, placeOrder, config }
  }

  it('闸门 ①：结构化拒绝且不抛异常、不触发行情与交易服务', async () => {
    const { tool, getTicker, placeOrder } = makeTool({ liveTrading: false })
    const result = await tool.execute({ ...MARKET_ARGS, dryRun: false })
    const parsed = JSON.parse(result) as { status: string; code: string }
    expect(parsed.status).toBe('rejected')
    expect(parsed.code).toBe('TRADING_LIVE_TRADING_DISABLED')
    expect(getTicker).not.toHaveBeenCalled()
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('闸门 ②：DRY-RUN 回执带 okx 公共 ticker 参照，不触交易服务', async () => {
    const { tool, placeOrder } = makeTool()
    const result = await tool.execute(MARKET_ARGS)
    const parsed = JSON.parse(result) as { dryRun: boolean; reference: { price: number } }
    expect(parsed.dryRun).toBe(true)
    expect(parsed.reference.price).toBe(42000.5)
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('闸门 ③：dryRun=false + liveTrading=true → 交易服务收到 dryRun:false 的真实下单意图', async () => {
    const { tool, placeOrder } = makeTool({ dryRun: false, liveTrading: true })
    await tool.execute({ ...MARKET_ARGS, dryRun: false })
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC-USDT', dryRun: false }))
  })

  it('参数校验：规范形 BTCUSDT 接受（2026-08-31 规范词汇）；无法解析的输入才拒绝', async () => {
    const { tool, getTicker } = makeTool()
    const result = await tool.execute({ ...MARKET_ARGS, instId: 'BTCUSDT' })
    expect((JSON.parse(result) as { dryRun: boolean }).dryRun).toBe(true) // 规范形顺利走完 dry-run 回执
    expect(getTicker).toHaveBeenCalledWith('BTCUSDT') // 规范形穿透到服务层，由服务互译为 BTC-USDT
    await expect(tool.execute({ ...MARKET_ARGS, instId: '!!!' })).rejects.toThrowError(/instId/)
  })
})

/* ------------------------------------------------------------------ */
/* 三 ref 凭证（主 agent 裁决 #3）                                          */
/* ------------------------------------------------------------------ */

describe('resolveCredentials（三 ref，每次操作解析）', () => {
  function fakeCtx(resolver: CredentialResolverLike | undefined, log?: string[]) {
    return {
      get(name: string) {
        if (name !== 'credentials') return undefined
        return resolver
      },
      log,
    }
  }

  it('env=demo 解析 demo ref 组（OKX_DEMO_*），resolve 每次操作被调用', async () => {
    const seenRefs: string[] = []
    let calls = 0
    const resolver: CredentialResolverLike = {
      async resolve(ref) {
        calls += 1
        seenRefs.push(ref)
        return { value: 'v' }
      },
    }
    const creds = await resolveCredentials(fakeCtx(resolver), baseConfig())
    expect(creds).toEqual({ key: 'v', secret: 'v', passphrase: 'v' })
    expect(seenRefs.sort()).toEqual(['OKX_DEMO_API_KEY', 'OKX_DEMO_PASSPHRASE', 'OKX_DEMO_SECRET_KEY'])
    expect(calls).toBe(3)
    // 第二次操作再次解析（不缓存——换 key 无需重启）。
    await resolveCredentials(fakeCtx(resolver), baseConfig())
    expect(calls).toBe(6)
  })

  it("env=live 解析 live ref 组（OKX_*）", async () => {
    const seenRefs: string[] = []
    const resolver: CredentialResolverLike = {
      async resolve(ref) {
        seenRefs.push(ref)
        return { value: 'v' }
      },
    }
    await resolveCredentials(fakeCtx(resolver), baseConfig({ env: 'live' }))
    expect(seenRefs.sort()).toEqual(['OKX_API_KEY', 'OKX_PASSPHRASE', 'OKX_SECRET_KEY'])
  })

  it('demo ref 未命中 → TRADING_CREDENTIALS_MISSING 且消息带 ref 名（不带值）', async () => {
    const resolver: CredentialResolverLike = {
      async resolve(ref) {
        return ref === 'OKX_DEMO_API_KEY' ? undefined : { value: 'v' }
      },
    }
    const error = await resolveCredentials(fakeCtx(resolver), baseConfig()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TradingServiceError)
    expect((error as TradingServiceError).code).toBe('TRADING_CREDENTIALS_MISSING')
    expect((error as TradingServiceError).message).toContain('OKX_DEMO_API_KEY')
    expect((error as TradingServiceError).message).toContain('env=demo')
  })

  it('无 credentials seam 时回落启动环境变量（llm-deepseek 同款降级）', async () => {
    process.env.OKX_DEMO_SECRET_KEY = 'ambient-secret'
    try {
      const resolver: CredentialResolverLike = {
        async resolve(ref) {
          return ref === 'OKX_DEMO_SECRET_KEY' ? undefined : { value: 'v' }
        },
      }
      const creds = await resolveCredentials(fakeCtx(resolver), baseConfig())
      expect(creds.secret).toBe('ambient-secret')
    } finally {
      delete process.env.OKX_DEMO_SECRET_KEY
    }
  })

  it('非法 ref 名（非环境变量名形态）→ TRADING_CREDENTIALS_MISSING', async () => {
    const error = await resolveCredentials(
      fakeCtx({ async resolve() { return { value: 'v' } } }),
      baseConfig({ demoApiKeyRef: 'not a ref!' }),
    ).catch((e: unknown) => e)
    expect((error as TradingServiceError).code).toBe('TRADING_CREDENTIALS_MISSING')
  })

  it('credentialRefsFor：env → ref 组映射（demo/live 两组并存于 Config）', () => {
    const config = baseConfig()
    expect(credentialRefsFor(config, 'demo').apiKeyRef).toBe('OKX_DEMO_API_KEY')
    expect(credentialRefsFor(config, 'live').apiKeyRef).toBe('OKX_API_KEY')
  })
})

/* ------------------------------------------------------------------ */
/* sz 单位纪律（调研 §4）                                                   */
/* ------------------------------------------------------------------ */

interface Route {
  match: (url: string, init: RequestInit) => boolean
  respond: (url: string, init: RequestInit) => Response
}

function routeFetch(routes: Route[]): { fetchImpl: typeof fetch; posts: Array<{ url: string; body: string; headers: Record<string, string> }> } {
  const posts: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  const fetchImpl = (async (input, init) => {
    const url = String(input)
    const requestInit = init ?? {}
    const route = routes.find((r) => r.match(url, requestInit))
    if (!route) throw new Error(`unexpected request: ${url}`)
    const headers = (requestInit.headers ?? {}) as Record<string, string>
    if (url.includes('/api/v5/trade/')) posts.push({ url, body: String(requestInit.body ?? ''), headers })
    return route.respond(url, requestInit)
  }) as unknown as typeof fetch
  return { fetchImpl, posts }
}

const SWAP_INSTRUMENT = {
  instId: 'BTC-USDT-SWAP', instType: 'SWAP', lotSz: '0.01', minSz: '0.01', tickSz: '0.1',
  ctVal: '0.01', ctValCcy: 'BTC', settleCcy: 'USDT',
}
const SPOT_INSTRUMENT = {
  instId: 'BTC-USDT', instType: 'SPOT', lotSz: '0.00000001', minSz: '0.00001', tickSz: '0.1',
  baseCcy: 'BTC', quoteCcy: 'USDT',
}

function okEnvelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: '0', data }), { status: 200 })
}

function makeTradeService(fetchImpl: typeof fetch, configOverrides: Partial<Config> = {}): OkxTradeService {
  const config = baseConfig(configOverrides)
  const credentials: OkxCredentials = { key: 'k', secret: 's', passphrase: 'p' }
  // Service 基类需要活的 cordis context（真实构造，replication 坑清单：# 私有/代理面）。
  return new OkxTradeService(new CordisContext() as never, {
    client: new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, clockSync: false, clockOffsetMs: 0 }),
    config,
    getCredentials: async () => credentials,
  })
}

describe('sz 单位纪律（placeOrder 换算）', () => {
  it('SWAP：quantity 0.02 BTC ÷ ctVal 0.01 → sz=2 张（币数语义恒定）', async () => {
    const { fetchImpl, posts } = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SWAP_INSTRUMENT]) },
      { match: (u) => u.includes('/api/v5/trade/order'), respond: () => okEnvelope([{ ordId: '12345', sCode: '0', sMsg: '' }]) },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    const order = await trade.placeOrder({ symbol: 'BTC-USDT-SWAP', side: 'buy', type: 'market', quantity: 0.02, dryRun: false })
    expect(order.id).toBe('12345')
    expect(order.dryRun).toBe(false)
    const body = JSON.parse(posts[0]?.body ?? '{}') as Record<string, unknown>
    expect(body.sz).toBe('2')
    expect(body.tdMode).toBe('cross') // 永续默认全仓（调研 §3.1）
    expect(body.tgtCcy).toBeUndefined() // tgtCcy 是现货市价单专用参数
  })

  it('SPOT 市价单：显式 tgtCcy=base_ccy（消除 buy 缺省按计价币金额的坑）', async () => {
    const { fetchImpl, posts } = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SPOT_INSTRUMENT]) },
      { match: (u) => u.includes('/api/v5/trade/order'), respond: () => okEnvelope([{ ordId: '67890', sCode: '0', sMsg: '' }]) },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    await trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01, dryRun: false })
    const body = JSON.parse(posts[0]?.body ?? '{}') as Record<string, unknown>
    expect(body.tgtCcy).toBe('base_ccy')
    expect(body.sz).toBe('0.01')
    expect(body.tdMode).toBe('cash')
  })

  it('SPOT limit 单不带 tgtCcy（limit 恒为 base 币数），px 进请求体', async () => {
    const { fetchImpl, posts } = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SPOT_INSTRUMENT]) },
      { match: (u) => u.includes('/api/v5/trade/order'), respond: () => okEnvelope([{ ordId: '1', sCode: '0', sMsg: '' }]) },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    await trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'limit', quantity: 0.01, price: 41000, dryRun: false })
    const body = JSON.parse(posts[0]?.body ?? '{}') as Record<string, unknown>
    expect(body.tgtCcy).toBeUndefined()
    expect(body.px).toBe('41000')
    expect(body.ordType).toBe('limit')
  })

  it('低于 minSz 本地拒绝（省一次 51000 往返）', async () => {
    const { fetchImpl } = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SWAP_INSTRUMENT]) },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    // 0.0001 BTC / 0.01 = 0.01 张，minSz=0.01 张恰好；改更小：0.00005 BTC = 0.005 张 < minSz。
    await expect(trade.placeOrder({ symbol: 'BTC-USDT-SWAP', side: 'buy', type: 'market', quantity: 0.00005, dryRun: false }))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR', message: expect.stringContaining('minSz') })
  })

  it('demo 下单带 x-simulated-trading: 1，live 不带（同一服务，env 决定）', async () => {
    const demo = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SPOT_INSTRUMENT]) },
      { match: (u) => u.includes('/api/v5/trade/order'), respond: () => okEnvelope([{ ordId: 'd1', sCode: '0', sMsg: '' }]) },
    ])
    await makeTradeService(demo.fetchImpl, { dryRun: false, liveTrading: true, env: 'demo' })
      .placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01, dryRun: false })
    expect(demo.posts[0]?.headers['x-simulated-trading']).toBe('1')

    const live = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SPOT_INSTRUMENT]) },
      { match: (u) => u.includes('/api/v5/trade/order'), respond: () => okEnvelope([{ ordId: 'l1', sCode: '0', sMsg: '' }]) },
    ])
    await makeTradeService(live.fetchImpl, { dryRun: false, liveTrading: true, env: 'live' })
      .placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01, dryRun: false })
    expect(live.posts[0]?.headers['x-simulated-trading']).toBeUndefined()
  })

  it('51008 余额不足 → TRADING_INSUFFICIENT_BALANCE', async () => {
    const { fetchImpl } = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SPOT_INSTRUMENT]) },
      {
        match: (u) => u.includes('/api/v5/trade/order'),
        respond: () => new Response(JSON.stringify({ code: '1', msg: '', data: [{ sCode: '51008', sMsg: 'Insufficient funds' }] }), { status: 200 }),
      },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    await expect(trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01, dryRun: false }))
      .rejects.toMatchObject({ code: 'TRADING_INSUFFICIENT_BALANCE' })
  })
})

/* ------------------------------------------------------------------ */
/* 撤单/查单/持仓/余额                                                       */
/* ------------------------------------------------------------------ */

describe('cancelOrder 幂等化与 getOrder 解析', () => {
  it('51400（已成交/已撤/不存在）视作终态成功（调研 §5「实现期定」）', async () => {
    const { fetchImpl } = routeFetch([
      {
        match: (u) => u.includes('/api/v5/trade/cancel-order'),
        respond: () => new Response(JSON.stringify({ code: '1', msg: '', data: [{ sCode: '51400', sMsg: 'Order already canceled or filled' }] }), { status: 200 }),
      },
    ])
    // 撤单走服务缝闸门 ③（live）：需要 liveTrading=true 且未强制模拟（P0）。
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    await expect(trade.cancelOrder('12345', 'BTC-USDT')).resolves.toBeUndefined()
  })

  it('51603（订单不存在）同样终态成功；缺 symbol → 结构化错误', async () => {
    const { fetchImpl } = routeFetch([
      {
        match: (u) => u.includes('/api/v5/trade/cancel-order'),
        respond: () => new Response(JSON.stringify({ code: '1', msg: '', data: [{ sCode: '51603', sMsg: 'Order does not exist' }] }), { status: 200 }),
      },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    await expect(trade.cancelOrder('x', 'BTC-USDT')).resolves.toBeUndefined()
    await expect(trade.cancelOrder('x')).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR', message: expect.stringContaining('instId') })
  })

  it('getOrder：state 映射 + SWAP accFillSz 张→币换算', async () => {
    const { fetchImpl } = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SWAP_INSTRUMENT]) },
      {
        match: (u) => u.includes('/api/v5/trade/order?'),
        respond: () => okEnvelope([{
          ordId: '12345', instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', state: 'partially_filled',
          px: '41000', sz: '2', accFillSz: '1', avgPx: '41000.5', uTime: '1700000000000', cTime: '1699999000000',
        }]),
      },
    ])
    const trade = makeTradeService(fetchImpl)
    const order = await trade.getOrder('BTC-USDT-SWAP', '12345')
    expect(order.status).toBe('partially_filled')
    expect(order.quantity).toBeCloseTo(0.02) // 2 张 × 0.01
    expect(order.filledQuantity).toBeCloseTo(0.01)
    expect(order.price).toBe(41000)
    expect(order.dryRun).toBe(false)
  })

  it('mapOrderState 保守映射（mmp_canceled → canceled；未知 → rejected）', () => {
    expect(mapOrderState('live')).toBe('new')
    expect(mapOrderState('filled')).toBe('filled')
    expect(mapOrderState('canceled')).toBe('canceled')
    expect(mapOrderState('mmp_canceled')).toBe('canceled')
    expect(mapOrderState('something_new')).toBe('rejected')
  })

  it('getPositions：net 负 pos = short，SWAP 张→币', async () => {
    const { fetchImpl } = routeFetch([
      { match: (u) => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SWAP_INSTRUMENT]) },
      {
        match: (u) => u.includes('/api/v5/account/positions'),
        respond: () => okEnvelope([{
          instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '-2', avgPx: '42000', markPx: '42100',
          upl: '2', lever: '3', uTime: '1700000000000',
        }]),
      },
    ])
    const trade = makeTradeService(fetchImpl)
    const positions = await trade.getPositions()
    expect(positions).toHaveLength(1)
    // 输出一律规范形（docs/symbol-vocabulary.md）：BTC-USDT-SWAP → BTCUSDT-SWAP
    expect(positions[0]).toMatchObject({ symbol: 'BTCUSDT-SWAP', side: 'short', size: 0.02, entryPrice: 42000, leverage: 3 })
  })

  it('getBalances：availEq/availBal/frozenBal 解析', async () => {
    const { fetchImpl } = routeFetch([
      {
        match: (u) => u.includes('/api/v5/account/balance'),
        respond: () => okEnvelope([{
          totalEq: '100',
          details: [
            { ccy: 'USDT', eq: '100', availEq: '90', frozenBal: '10' },
            { ccy: 'BTC', eq: '', availBal: '0.5', frozenBal: '0' },
          ],
        }]),
      },
    ])
    const trade = makeTradeService(fetchImpl)
    const balances = await trade.getBalances()
    expect(balances).toEqual([
      { asset: 'USDT', free: 90, locked: 10 },
      { asset: 'BTC', free: 0.5, locked: 0 },
    ])
  })
})

/* ------------------------------------------------------------------ */
/* 服务层模拟回执（api 契约：placeOrder 缺省 dry-run）                         */
/* ------------------------------------------------------------------ */

describe('OkxTradeService.placeOrder 缺省 dry-run', () => {
  it('dryRun !== false → 本地回执不触网', async () => {
    const { fetchImpl } = routeFetch([]) // 空路由：任何请求都会炸
    const trade = makeTradeService(fetchImpl)
    const order = await trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01 })
    expect(order.dryRun).toBe(true)
    expect(order.status).toBe('filled')
  })

  it('buildDryRunReceipt：参照行情不可用时不失败（unavailable 标注）', async () => {
    const receipt = await buildDryRunReceipt({ ...MARKET_ARGS, instId: 'BTC-USDT' }, {
      getTicker: async () => { throw new Error('network down') },
    })
    const parsed = JSON.parse(receipt) as { dryRun: boolean; reference: { unavailable?: string } }
    expect(parsed.dryRun).toBe(true)
    expect(parsed.reference.unavailable).toContain('network down')
  })
})
