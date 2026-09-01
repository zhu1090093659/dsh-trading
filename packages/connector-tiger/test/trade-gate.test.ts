/**
 * 服务缝闸门（P0 · issue #29）：绕过工具层直调 TradeService 的三态矩阵（离线）。
 * 工具层 evaluateOrderGate / base 审批闸门另有覆盖；这里只证服务级 fail-closed——
 * dsh-tool-cordis 动态包宿主半 inject 本服务直调时同样过闸（liveTrading !== true
 * 拒绝或模拟；=== true 放行）。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { TigerTradeService, type Config } from '../src/index.js'

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    env: 'demo',
    dryRun: true,
    liveTrading: false,

    ...overrides,
  }
}

function stubFetch(routes: Array<{ match: string; body: unknown }> = []) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error('unexpected request: ' + url)
    return new Response(JSON.stringify(route.body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { impl, urls }
}

function makeService(config: Config, routes: Array<{ match: string; body: unknown }> = []) {
  const { impl, urls } = stubFetch(routes)
  // Service 基类需要活的 cordis context（connector-okx trade.test.ts 同款构造）。
  const trade = new TigerTradeService(new CordisContext() as never, { tigerId: 'T1', accountId: 'ACC1', privateKey: 'pk', fetchImpl: impl, config })
  return { trade, urls }
}

const LIVE_REQ = { symbol: '00700.HK', side: 'buy' as const, type: 'market' as const, quantity: 1, dryRun: false }

describe('TigerTradeService 服务缝闸门（P0，绕过工具层直调）', () => {
  it('① dryRun=false + liveTrading=false（缺省）→ TRADING_LIVE_TRADING_DISABLED，不触网', async () => {
    const { trade, urls } = makeService(baseConfig())
    await expect(trade.placeOrder(LIVE_REQ)).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
    expect(urls).toHaveLength(0)
  })

  it('② dryRun 缺省直调 → 本地模拟回执（dryRun=true），不触网', async () => {
    const { trade, urls } = makeService(baseConfig())
    const order = await trade.placeOrder({ symbol: '00700.HK', side: 'buy', type: 'market', quantity: 1 })
    expect(order.dryRun).toBe(true)
    expect(order.status).toBe('filled')
    expect(urls).toHaveLength(0)
  })

  it('② config.dryRun=true 强制模拟：liveTrading=true + dryRun=false 请求也回模拟回执，不触网', async () => {
    const { trade, urls } = makeService(baseConfig({ dryRun: true, liveTrading: true }))
    const order = await trade.placeOrder(LIVE_REQ)
    expect(order.dryRun).toBe(true)
    expect(urls).toHaveLength(0)
  })

  it('③ liveTrading=true + dryRun=false → 闸门放行（后续 rest 层行为不属于闸门职责）', async () => {
    const { trade } = makeService(baseConfig({ dryRun: false, liveTrading: true }), [{ match: '', body: {} }])
    const err = await trade.placeOrder(LIVE_REQ).then(() => null, (e) => e)
    if (err) expect((err as { code?: string }).code).not.toBe('TRADING_LIVE_TRADING_DISABLED')
  })

  it('撤单 ①：liveTrading=false（缺省）直调 → TRADING_LIVE_TRADING_DISABLED，不触网', async () => {
    const { trade, urls } = makeService(baseConfig())
    await expect(trade.cancelOrder('ord-1')).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
    expect(urls).toHaveLength(0)
  })

  it('撤单 ③：liveTrading=true + dryRun=false → 不再被服务缝拒绝', async () => {
    const { trade } = makeService(baseConfig({ dryRun: false, liveTrading: true }), [{ match: '', body: {} }])
    const err = await trade.cancelOrder('ord-1').then(() => null, (e) => e)
    if (err) expect((err as { code?: string }).code).not.toBe('TRADING_LIVE_TRADING_DISABLED')
  })
})
