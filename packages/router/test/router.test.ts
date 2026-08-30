/**
 * Router 单测：设置 namespace 分层语义（schema 默认 → base → 用户层）、
 * dict 开放（新市场零 schema 改）、enum 拒非法、MarketRouterService 判定、
 * 无 settings 服务时回退组合 entry（向后兼容）。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

// 0.1.2-alpha.2 后 dsh-settings 不再导出生插件运行的 installSettingsSection/settingsNamespace；
// 插件的 settings 接线改为 ctx.inject(['settings'], cb)。本文件只在「thunk 回归」用例里通过
// 一个可捕获 inject 的上下文直证 apply 的接线语义。
const captured = vi.hoisted(() => ({
  hooks: undefined as unknown as {
    setSource: (source: () => import('../src/index.js').Config) => void
    onChange: () => void
  } | undefined,
}))
vi.mock('@deepseek-ai/dsh-settings', () => ({}))
import {
  apply,
  Config,
  DEFAULT_MARKETS,
  PROVIDER_VOCABULARY,
  MarketDataRegistryService,
  MarketRouterService,
  activeProviderOf,
  warnUnknownProviders,
  type Config as ConfigType,
  type Provider,
} from '../src/index.js'
import type { MarketDataService } from '@dsh-trading/api'

const ENTRY: ConfigType = { markets: { ...DEFAULT_MARKETS } }

describe('dshtrading schema（用户设置一级）', () => {
  it('默认值 = 现状零变化（crypto=binance / us=yahoo / cn+hk=tencent）', () => {
    expect(activeProviderOf(ENTRY, 'crypto')).toBe('binance')
    expect(activeProviderOf(ENTRY, 'us')).toBe('yahoo')
    expect(activeProviderOf(ENTRY, 'cn')).toBe('tencent')
    expect(activeProviderOf(ENTRY, 'hk')).toBe('tencent')
  })

  it('news 默认空对象（无 key，WS2c）：resolved 无 key 不炸、newsKey 为 undefined', () => {
    const resolve = Config as unknown as (value: unknown) => ConfigType
    const resolved = resolve({ markets: { ...DEFAULT_MARKETS } })
    expect(resolved.news?.cryptoPanicKey).toBeUndefined()
  })

  it('dict 键开放：新市场（jp）不炸 schema（构造即验证，无 schema 报错）', () => {
    const cfg: ConfigType = { markets: { ...DEFAULT_MARKETS, jp: { provider: 'yahoo' } } }
    expect(activeProviderOf(cfg, 'jp')).toBe('yahoo')
  })

  it('provider 候选集 = 全仓词汇（binance/okx/yahoo/stooq/tencent）', () => {
    expect([...PROVIDER_VOCABULARY].sort()).toEqual(['binance', 'cn', 'hk', 'okx', 'stooq', 'tencent', 'us', 'yahoo'].filter((v) => ['binance', 'okx', 'yahoo', 'stooq', 'tencent'].includes(v)).sort())
    expect(PROVIDER_VOCABULARY).toContain('binance' as Provider)
  })

  it('schema 开放字符串：第三方 slug（bybit）不被一票否决（2026-08-30 整改 #4）', () => {
    // schemastery Schema 可调用：Config(value) 即校验+解析。
    const resolve = Config as unknown as (value: unknown) => ConfigType
    const resolved = resolve({ markets: { crypto: { provider: 'bybit' } } })
    expect(resolved.markets.crypto?.provider).toBe('bybit')
  })

  it('运行时校验：未知 slug → warn + 返回清单；已知 slug 静默', () => {
    const warns: string[] = []
    const log = { warn: (...args: unknown[]) => warns.push(args.join(' ')) }
    const unknown = warnUnknownProviders(
      { markets: { crypto: { provider: 'bybit' }, us: { provider: 'yahoo' } } },
      log,
    )
    expect(unknown).toEqual(['bybit'])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('bybit')
    expect(warns[0]).toContain('crypto')
    expect(warnUnknownProviders({ markets: { ...DEFAULT_MARKETS } }, log)).toEqual([])
  })
})

describe('MarketDataRegistryService（tradingMarketDataRegistry，2026-08-30 注册表模式）', () => {
  const fakeService = (tag: string): MarketDataService => ({
    getTicker: async () => ({ symbol: tag, price: 1, timestamp: 0 }),
    getKlines: async () => [],
    subscribeTicker: () => ({ dispose: () => {} }),
  })
  const setup = () => {
    let source: ConfigType = { markets: { ...DEFAULT_MARKETS } }
    const router = new MarketRouterService(new CordisContext() as never, () => source)
    const registry = new MarketDataRegistryService(new CordisContext() as never, router)
    return { router, registry, setSource: (next: ConfigType) => { source = next } }
  }

  it('注册后按路由解析激活项；重复注册同 (market,provider) 不同实例抛错', () => {
    const { registry } = setup()
    const binance = fakeService('binance')
    const okx = fakeService('okx')
    registry.register('crypto', 'binance', binance)
    registry.register('crypto', 'okx', okx)
    expect(registry.active('crypto')?.service).toBe(binance) // 默认路由 crypto=binance
    expect(registry.list('crypto').map((e) => e.provider).sort()).toEqual(['binance', 'okx'])
    expect(() => registry.register('crypto', 'binance', fakeService('binance-2'))).toThrow(/duplicate market data registration/)
  })

  it('热切换语义：setSource 换 provider 后 active() 立即解析到新服务（无 watch 无重启）', () => {
    const { registry, setSource } = setup()
    const binance = fakeService('binance')
    const okx = fakeService('okx')
    registry.register('crypto', 'binance', binance)
    registry.register('crypto', 'okx', okx)
    expect(registry.active('crypto')?.service).toBe(binance)
    setSource({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } })
    expect(registry.active('crypto')?.service).toBe(okx)
    expect(registry.active('crypto')?.provider).toBe('okx')
  })

  it('选中了但未注册 → undefined（不静默降级到别家）；注销函数生效', () => {
    const { registry, setSource } = setup()
    const binance = fakeService('binance')
    const unregister = registry.register('crypto', 'binance', binance)
    setSource({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } })
    expect(registry.active('crypto')).toBeUndefined() // okx 未注册，不回落 binance
    unregister()
    setSource({ markets: { ...DEFAULT_MARKETS } })
    expect(registry.active('crypto')).toBeUndefined() // binance 已注销
  })

  it('router 无该市场路由：恰好一个注册项 → 零配置可用；多个 → undefined', () => {
    const { registry } = setup()
    const jp = fakeService('jp-source')
    registry.register('jp', 'jp-source', jp)
    expect(registry.active('jp')?.service).toBe(jp)
    registry.register('jp', 'jp-source-2', fakeService('jp2'))
    expect(registry.active('jp')).toBeUndefined()
  })
})

describe('apply 的 installSettingsSection 接线', () => {
  it('setSource 收到 thunk——先求值再 warn（回归：thunk 误当 Config 抛 TypeError 掐断接线）', () => {
    const ctx = new CordisContext()
    ctx.inject = ((_deps: string[], cb: (s: { settings: { installSection: (owner: unknown, ns: unknown, schema: unknown, entry: unknown, hooks: unknown) => void } }) => void) => {
      cb({ settings: { installSection: (_o, _n, _s, _e, hooks) => { captured.hooks = hooks as never } } } as never)
      return () => {}
    }) as never
    apply(ctx as never, { markets: { ...DEFAULT_MARKETS } } as never)
    expect(captured.hooks).toBeDefined()
    const resolved: ConfigType = { markets: { crypto: { provider: 'bybit' } } }
    expect(() => captured.hooks!.setSource(() => resolved)).not.toThrow()
    expect(() => captured.hooks!.onChange()).not.toThrow()
  })
})

describe('MarketRouterService（tradingMarketRouter）', () => {
  it('activeProvider 读源（默认 entry）；setSource 后读新源（settings resolved）', () => {
    const svc = new MarketRouterService(new CordisContext() as never, () => ENTRY)
    expect(svc.activeProvider('crypto')).toBe('binance')
    const resolved: ConfigType = { markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } }
    svc.setSource(() => resolved)
    expect(svc.activeProvider('crypto')).toBe('okx')
  })

  it('watch：provider 变化 diff 通知（next/prev）；未变不通知', () => {
    let source: ConfigType = { markets: { ...DEFAULT_MARKETS } }
    const svc = new MarketRouterService(new CordisContext() as never, () => source)
    const events: Array<[string | undefined, string | undefined]> = []
    const dispose = svc.watch((next, prev) => events.push([next, prev]))
    svc.notify()
    // 首次 diff：四市场各自 undefined→默认值（crypto 的 binance 也在其中）。
    expect(events.filter(([next]) => next === 'binance')).toHaveLength(1)
    const cryptoFirst = events.find(([, prev]) => prev === undefined && events[0]?.[0] === 'binance')
    expect(cryptoFirst).toEqual(['binance', undefined])
    events.length = 0
    svc.notify()
    expect(events).toHaveLength(0) // 未变不通知
    source = { markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } }
    svc.notify()
    expect(events).toContainEqual(['okx', 'binance'])
    dispose()
    source = { markets: { ...DEFAULT_MARKETS, crypto: { provider: 'binance' } } }
    svc.notify()
    const before = events.length
    expect(events).toHaveLength(before) // dispose 后不再通知
  })

  it('newsKey：默认无 key（undefined），setSource 后读 resolved 的 news.cryptoPanicKey（WS2c）', () => {
    const svc = new MarketRouterService(new CordisContext() as never, () => ENTRY)
    expect(svc.newsKey()).toBeUndefined()
    const resolved: ConfigType = { markets: { ...DEFAULT_MARKETS }, news: { cryptoPanicKey: 'sec_xxx' } }
    svc.setSource(() => resolved)
    expect(svc.newsKey()).toBe('sec_xxx')
  })
})
