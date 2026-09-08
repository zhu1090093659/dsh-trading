/**
 * 数据面行单测（注册表模式，2026-08-30 整改 #1 + 2026-09-08 审查 M3）：
 * 行情面按市场各建实例——注册 (hk, futu) 与 (us, futu)，两个市场必须是**不同实例**
 * （此前 us 复用 hk 实例，美股搜索返回港股清单）；gatewayUrl 必须透传到两个市场的
 * REST 客户端（此前行情面恒落默认 11111，打到 OpenD 原生 TCP 端口会 10s 超时）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/dataplane.ts'
import { TRADING_HK_MARKET_DATA_KEY, type Config } from '../src/index.js'

const GATEWAY = 'http://127.0.0.1:11112'
const CONFIG: Config = {
  enabled: true,
  gatewayUrl: GATEWAY,
  dryRun: true,
  liveTrading: false,
  unlockPwdRef: 'FUTU_UNLOCK_PWD',
}

interface Registered { market: string; provider: string; service: unknown }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 全局 fetch 打桩并记录请求 URL（网关 URL 走真实请求路径断言，不探服务私有字段）。 */
function stubGlobalFetch(): string[] {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    return jsonResponse({ retType: 0, data: { curPrice: 380.2, volume: 1000, time: 1725000000000 } })
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

describe('connector-futu dataplane（注册表模式）', () => {
  it('enabled=true → 注册 (hk, futu) 与 (us, futu)，不占 host 根市场键', () => {
    const { ctx, provided, registrations } = makeRegistryCtx()
    apply(ctx, CONFIG)
    expect(registrations.map((r) => `${r.market}:${r.provider}`)).toEqual(['hk:futu', 'us:futu'])
    expect(registrations.every((r) => r.service !== undefined)).toBe(true)
    expect(provided.tradingHkMarketData).toBeUndefined()
  })

  it('us 面服务与 hk 面服务是两个不同实例（2026-09-08 审查 M3）', () => {
    const { ctx, registrations } = makeRegistryCtx()
    apply(ctx, CONFIG)
    const hk = registrations.find((r) => r.market === 'hk')?.service
    const us = registrations.find((r) => r.market === 'us')?.service
    expect(hk).toBeDefined()
    expect(us).toBeDefined()
    expect(us).not.toBe(hk)
  })

  it('us 实例走独立 isolate 键，不与 hk 共享 realm', () => {
    const { ctx, isolateNames } = makeRegistryCtx()
    apply(ctx, CONFIG)
    expect(isolateNames).toEqual([TRADING_HK_MARKET_DATA_KEY, 'tradingUsMarketData'])
  })

  it('gatewayUrl 透传到 hk 与 us 两个市场的 REST 客户端（请求打到 11112）', async () => {
    const urls = stubGlobalFetch()
    const { ctx, registrations } = makeRegistryCtx()
    apply(ctx, CONFIG)
    const hk = registrations.find((r) => r.market === 'hk')?.service as { getTicker(s: string): Promise<unknown> }
    const us = registrations.find((r) => r.market === 'us')?.service as { getTicker(s: string): Promise<unknown> }

    await hk.getTicker('00700.HK')
    await us.getTicker('AAPL')

    expect(urls).toHaveLength(2)
    for (const url of urls) {
      expect(new URL(url).origin).toBe(GATEWAY)
      expect(new URL(url).port).toBe('11112')
    }
    expect(urls[0]).toContain('security=HK.00700')
    expect(urls[1]).toContain('security=US.AAPL')
  })

  it('enabled=false → 不注册任何市场', () => {
    const { ctx, provided, registrations, isolateNames } = makeRegistryCtx()
    apply(ctx, { ...CONFIG, enabled: false })
    expect(registrations).toHaveLength(0)
    expect(isolateNames).toHaveLength(0)
    expect(Object.keys(provided)).toHaveLength(0)
  })
})

describe('connector-futu dataplane（无注册表的老部署回退）', () => {
  function makeLegacyCtx(): { ctx: Context; provided: Record<string, unknown> } {
    const provided: Record<string, unknown> = {}
    const ctx = {
      get: () => undefined,
      reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    } as unknown as Context
    return { ctx, provided }
  }

  it('无注册表 → 回退只 provide 港股市场键（旧桥消费，仅 hk）', () => {
    const { ctx, provided } = makeLegacyCtx()
    apply(ctx, CONFIG)
    expect(Object.keys(provided)).toEqual([TRADING_HK_MARKET_DATA_KEY])
    expect(provided.tradingHkMarketData).toBeDefined()
  })

  it('回退实例同样透传 gatewayUrl', async () => {
    const urls = stubGlobalFetch()
    const { ctx, provided } = makeLegacyCtx()
    apply(ctx, CONFIG)
    const service = provided.tradingHkMarketData as { getTicker(s: string): Promise<unknown> }
    await service.getTicker('00700.HK')
    expect(urls).toHaveLength(1)
    expect(new URL(urls[0] as string).port).toBe('11112')
  })
})
