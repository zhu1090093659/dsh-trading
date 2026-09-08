/**
 * 数据面行单测（注册表模式）：config.market 分流 isolate 键与注册市场（hk →
 * tradingHkMarketData/(hk, eastmoney)；缺省 → cn）。
 *
 * 关键判别：实例市场必须透传到 REST 客户端（2026-09-08 审查 H3 修复——此前
 * 构造时丢 { market }，hk 行落回 cn 形态解析，港股宽容形 700 被解析成另一个
 * 市场的证券）。因此这里不探私有字段，而是直接以 700 查询：港股实例命中
 * secid 116.00700，cn 实例则显式拒绝。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/dataplane.ts'
import {
  ROUTER_PROVIDER,
  TRADING_CN_MARKET_DATA_KEY,
  TRADING_HK_MARKET_DATA_KEY,
  routeAllows,
  type Config,
} from '../src/index.js'

interface Registered { market: string; provider: string; service: unknown }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 全局 fetch 打桩并记录请求 URL（东财 REST 客户端在构造时读 globalThis.fetch）。 */
function stubGlobalFetch(): string[] {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    return jsonResponse({ data: { f43: 380200, f58: '腾讯控股', f47: 15000000, f86: 1725000000 } })
  }) as typeof fetch
  vi.stubGlobal('fetch', impl)
  return urls
}

function makeRegistryCtx(): { ctx: Context; provided: Record<string, unknown>; registrations: Registered[]; isolateNames: string[] } {
  const provided: Record<string, unknown> = {}
  const registrations: Registered[] = []
  const isolateNames: string[] = []
  const registry = {
    register: (market: string, provider: string, service: unknown) => {
      registrations.push({ market, provider, service })
      return () => {}
    },
  }
  const ctx = {
    get: (key: string) => (key === 'tradingMarketDataRegistry' ? registry : undefined),
    isolate: (name: string) => {
      isolateNames.push(name)
      return { reflect: { provide: () => {} } }
    },
    effect: (fn: () => () => void) => { fn() },
    reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
  } as unknown as Context
  return { ctx, provided, registrations, isolateNames }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('connector-eastmoney dataplane（注册表模式）', () => {
  it("market='hk' → isolate tradingHkMarketData + 注册 (hk, eastmoney)，且实例按港股解析", async () => {
    const urls = stubGlobalFetch()
    const { ctx, provided, registrations, isolateNames } = makeRegistryCtx()
    apply(ctx, { enabled: true, market: 'hk' })

    expect(isolateNames).toEqual([TRADING_HK_MARKET_DATA_KEY])
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.market).toBe('hk')
    expect(registrations[0]?.provider).toBe(ROUTER_PROVIDER)
    expect(provided.tradingHkMarketData).toBeUndefined() // 根键不被占用

    // 港股宽容形 700 只有 hk 实例受理（cn 实例会抛 TRADING_UNSUPPORTED_SYMBOL）
    const service = registrations[0]?.service as { getTicker(s: string): Promise<{ symbol: string }> }
    const ticker = await service.getTicker('700')
    expect(ticker.symbol).toBe('00700.HK')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('secid=116.00700')
  })

  it('缺省 market → isolate tradingCnMarketData + 注册 (cn, eastmoney)，且实例按 A 股解析', async () => {
    const urls = stubGlobalFetch()
    const { ctx, provided, registrations, isolateNames } = makeRegistryCtx()
    apply(ctx, { enabled: true })

    expect(isolateNames).toEqual([TRADING_CN_MARKET_DATA_KEY])
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.market).toBe('cn')
    expect(registrations[0]?.provider).toBe(ROUTER_PROVIDER)
    expect(provided.tradingCnMarketData).toBeUndefined()

    const service = registrations[0]?.service as { getTicker(s: string): Promise<{ symbol: string }> }
    const ticker = await service.getTicker('600519.SH')
    expect(ticker.symbol).toBe('600519.SH')
    expect(urls[0]).toContain('secid=1.600519')
    // cn 实例不接港股宽容形（市场不串味）
    await expect(service.getTicker('700')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })

  it('enabled=false → 不 isolate、不注册', () => {
    const { ctx, provided, registrations, isolateNames } = makeRegistryCtx()
    apply(ctx, { enabled: false, market: 'hk' })
    expect(isolateNames).toHaveLength(0)
    expect(registrations).toHaveLength(0)
    expect(Object.keys(provided)).toHaveLength(0)
  })
})

describe('connector-eastmoney dataplane（无注册表的老部署回退）', () => {
  function makeLegacyCtx(): { ctx: Context; provided: Record<string, unknown> } {
    const provided: Record<string, unknown> = {}
    const ctx = {
      get: () => undefined,
      reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    } as unknown as Context
    return { ctx, provided }
  }

  it("market='hk' → 回退 provide tradingHkMarketData，且回退实例同样按港股解析", async () => {
    const urls = stubGlobalFetch()
    const { ctx, provided } = makeLegacyCtx()
    apply(ctx, { enabled: true, market: 'hk' })

    expect(Object.keys(provided)).toEqual([TRADING_HK_MARKET_DATA_KEY])
    const service = provided.tradingHkMarketData as { getTicker(s: string): Promise<{ symbol: string }> }
    const ticker = await service.getTicker('700')
    expect(ticker.symbol).toBe('00700.HK')
    expect(urls[0]).toContain('secid=116.00700')
  })

  it('缺省 market → 回退 provide tradingCnMarketData', () => {
    const { ctx, provided } = makeLegacyCtx()
    apply(ctx, { enabled: true })
    expect(Object.keys(provided)).toEqual([TRADING_CN_MARKET_DATA_KEY])
  })
})

describe('connector-eastmoney routeAllows 路由闸门', () => {
  const CONFIG: Config = { enabled: true, market: 'hk' }

  function routerCtx(active: string | undefined): Context {
    return {
      get: (key: string) => (key === 'tradingMarketRouter' ? { activeProvider: () => active } : undefined),
    } as unknown as Context
  }

  it('路由选中其它 provider → 本连接器让位', () => {
    expect(routeAllows(routerCtx('tencent'), CONFIG, 'hk')).toBe(false)
  })

  it('路由选中 eastmoney → 放行', () => {
    expect(routeAllows(routerCtx('eastmoney'), CONFIG, 'hk')).toBe(true)
  })

  it('无路由（老部署）→ 放行；enabled=false → 一律拒绝', () => {
    expect(routeAllows({ get: () => undefined } as unknown as Context, CONFIG, 'hk')).toBe(true)
    expect(routeAllows(routerCtx('eastmoney'), { ...CONFIG, enabled: false }, 'hk')).toBe(false)
  })
})
