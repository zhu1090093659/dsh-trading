/**
 * 服务缝闸门（P0 · issue #29）：绕过工具层直调 TradeService 的三态矩阵（离线）。
 * 工具层 evaluateOrderGate / base 审批闸门另有覆盖；这里只证服务级 fail-closed——
 * dsh-tool-cordis 动态包宿主半 inject 本服务直调时同样过闸（liveTrading !== true
 * 拒绝或模拟；=== true 放行）。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { PolygonTradeService, type Config } from '../src/index.js'

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    env: 'demo',
    dryRun: true,
    liveTrading: false,
  apiKeyRef: 'POLYGON_API_KEY',
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
  const trade = new PolygonTradeService(new CordisContext() as never, { apiKey: 'k', fetchImpl: impl, config })
  return { trade, urls }
}

const LIVE_REQ = { symbol: 'AAPL', side: 'buy' as const, type: 'market' as const, quantity: 1, dryRun: false }

describe('PolygonTradeService 服务缝闸门（P0，绕过工具层直调）', () => {
  it('① dryRun=false + liveTrading=false（缺省）→ TRADING_LIVE_TRADING_DISABLED，不触网', async () => {
    const { trade, urls } = makeService(baseConfig())
    await expect(trade.placeOrder(LIVE_REQ)).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
    expect(urls).toHaveLength(0)
  })

  it('② dryRun 缺省直调 → 本地模拟回执（dryRun=true），不触网', async () => {
    const { trade, urls } = makeService(baseConfig())
    const order = await trade.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: 1 })
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

  it('③ liveTrading=true + dryRun=false → 闸门放行，到达 rest 层（当前 sim stub 回执如实标注 dryRun）', async () => {
    const { trade } = makeService(baseConfig({ dryRun: false, liveTrading: true }), [{ match: '', body: {} }])
    const order = await trade.placeOrder(LIVE_REQ)
    expect(order.id).toMatch(/^sim-/)
    expect(order.dryRun).toBe(true)
  })

  it('撤单 ①：liveTrading=false（缺省）直调 → TRADING_LIVE_TRADING_DISABLED，不触网', async () => {
    const { trade, urls } = makeService(baseConfig())
    await expect(trade.cancelOrder('ord-1')).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
    expect(urls).toHaveLength(0)
  })

  it('撤单 ③：liveTrading=true + dryRun=false → 放行（rest stub 返回已撤）', async () => {
    const { trade } = makeService(baseConfig({ dryRun: false, liveTrading: true }), [{ match: '', body: {} }])
    await expect(trade.cancelOrder('ord-1')).resolves.toMatchObject({ orderId: 'ord-1', status: 'canceled' })
  })
})
