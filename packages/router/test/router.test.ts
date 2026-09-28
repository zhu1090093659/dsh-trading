/**
 * Router 单测：设置行配置语义（0.1.7 volatile 契约：引用读取 + 热更新）、
 * dict 开放（新市场零 schema 改）、MarketRouterService 判定、
 * volatile-update 驱动的 watchers 通知。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import {
  apply,
  Config,
  DEFAULT_MARKETS,
  PROVIDER_VOCABULARY,
  MarketDataRegistryService,
  TradeRegistryService,
  TradingNewsRegistryService,
  MarketRouterService,
  activeProviderOf,
  warnUnknownProviders,
  type Config as ConfigType,
  type Provider,
} from '../src/index.js'
import type { MarketDataService, NewsAggregator, TradeService } from '@dshtrading/api'

const ENTRY: ConfigType = { markets: { ...DEFAULT_MARKETS } }

/** 可变引用模拟 cosmokit VolatileRef：setConfig 换内容 = loader 提交新快照。 */
function mutableRef(initial: ConfigType): { ref: { get: () => ConfigType }; set: (next: ConfigType) => void } {
  let current = initial
  return { ref: { get: () => current }, set: (next) => { current = next } }
}

/** 根 volatile 后 Config(value) 返回 VolatileRef——取 .get() 快照做数据断言。 */
function resolveConfig(value: unknown): ConfigType {
  const resolved = (Config as unknown as (v: unknown) => { get: () => ConfigType })(value)
  return resolved.get()
}

describe('dshtrading schema（用户设置一级）', () => {
  it('默认值 = 现状零变化（crypto=binance / us=yahoo / cn+hk=tencent）', () => {
    expect(activeProviderOf(ENTRY, 'crypto')).toBe('binance')
    expect(activeProviderOf(ENTRY, 'us')).toBe('yahoo')
    expect(activeProviderOf(ENTRY, 'cn')).toBe('tencent')
    expect(activeProviderOf(ENTRY, 'hk')).toBe('tencent')
  })

  it('news 默认空对象（无 key，WS2c）：resolved 无 key 不炸、newsKey 为 undefined', () => {
    const resolved = resolveConfig({ markets: { ...DEFAULT_MARKETS } })
    expect(resolved.news?.cryptoPanicKey).toBeUndefined()
  })

  it('用户改涨跌配色后设置页能回显：colorMode 进 schema 投影（默认 red-up、显式 green-up 透传）', () => {
    // Given: 设置页的涨跌配色 radio 读写 Config.colorMode（0.1.7 describe 只投影 schema 声明字段）
    const declared = (Config as unknown as { dict?: Record<string, unknown> }).dict ?? {}
    // When: 读默认配置与显式 green-up 配置
    const fallback = resolveConfig({ markets: { ...DEFAULT_MARKETS } })
    const overridden = resolveConfig({ markets: { ...DEFAULT_MARKETS }, colorMode: 'green-up' })
    // Then: 字段已声明，且默认回 red-up、显式值原样透传（未声明 = 写得进读不回，radio 无法回显）
    expect(Object.keys(declared)).toContain('colorMode')
    expect(fallback.colorMode).toBe('red-up')
    expect(overridden.colorMode).toBe('green-up')
  })

  it('dict 键开放：新市场（jp）不炸 schema（构造即验证，无 schema 报错）', () => {
    const cfg: ConfigType = { markets: { ...DEFAULT_MARKETS, jp: { provider: 'yahoo' } } }
    expect(activeProviderOf(cfg, 'jp')).toBe('yahoo')
  })

  it('provider 候选集 = 全仓词汇（binance/okx/bybit/ccxt/yahoo/stooq/alpaca/fmp/finnhub/polygon/ibkr/tencent/eastmoney/tushare/akshare/qmt/futu/longbridge/tiger/hithink/jin10/xysz）', () => {
    expect([...PROVIDER_VOCABULARY].sort()).toEqual([
      'akshare',
      'alpaca',
      'binance',
      'bybit',
      'ccxt',
      'eastmoney',
      'finnhub',
      'fmp',
      'futu',
      'hithink',
      'ibkr',
      'jin10',
      'longbridge',
      'okx',
      'polygon',
      'qmt',
      'stooq',
      'tencent',
      'tiger',
      'tushare',
      'xysz',
      'yahoo',
    ].sort())
    expect(PROVIDER_VOCABULARY).toContain('binance' as Provider)
    expect(PROVIDER_VOCABULARY).toContain('ibkr' as Provider)
    expect(PROVIDER_VOCABULARY).toContain('qmt' as Provider)
    expect(PROVIDER_VOCABULARY).toContain('tiger' as Provider)
    expect(PROVIDER_VOCABULARY).toContain('xysz' as Provider)
  })

  it('schema 开放字符串：第三方 slug（custom_dex）不被一票否决（2026-08-30 整改 #4）', () => {
    const resolved = resolveConfig({ markets: { crypto: { provider: 'custom_dex' } } })
    expect(resolved.markets.crypto?.provider).toBe('custom_dex')
  })

  it('用户在设置页保存数据源时写入被 schema 放行：Config 根标 volatile，解析结果是可取快照的引用', async () => {
    // Given: router Config 声明（0.1.7 SettingsForms.write 只接受 volatile 声明的字段）
    const cosmokit = await import('@deepseek-ai/cosmokit')
    // When: 读取 schema 根标记与一次解析结果
    const rootVolatile = (Config as unknown as { meta?: { volatile?: boolean } }).meta?.volatile
    const resolved = resolveConfig({ markets: { ...DEFAULT_MARKETS } })
    // Then: 根标 volatile（isVolatilePath 对所有字段放行），.get() 后是纯数据快照
    expect(rootVolatile).toBe(true)
    expect(cosmokit.isVolatile(resolved)).toBe(false)
    expect(resolved.markets.crypto?.provider).toBe('binance')
  })

  it('运行时校验：未知 slug → warn + 返回清单；已知 slug 静默', () => {
    const warns: string[] = []
    const log = { warn: (...args: unknown[]) => warns.push(args.join(' ')) }
    const unknown = warnUnknownProviders(
      { markets: { crypto: { provider: 'unknown_dex' }, us: { provider: 'yahoo' } } },
      log,
    )
    expect(unknown).toEqual(['unknown_dex'])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('unknown_dex')
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
    const box = mutableRef({ markets: { ...DEFAULT_MARKETS } })
    const router = new MarketRouterService(new CordisContext() as never, box.ref)
    const registry = new MarketDataRegistryService(new CordisContext() as never, router)
    return { router, registry, setConfig: (next: ConfigType) => box.set(next) }
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

  it('用户在设置页切换数据源后注册表按最新路由解析到新服务（无 watch 无重启）', () => {
    // Given: crypto 市场 binance 与 okx 都已注册，当前路由为 binance
    const { registry, setConfig } = setup()
    const binance = fakeService('binance')
    const okx = fakeService('okx')
    registry.register('crypto', 'binance', binance)
    registry.register('crypto', 'okx', okx)
    expect(registry.active('crypto')?.service).toBe(binance)
    // When: 用户保存把路由改成 okx（loader 提交新 volatile 快照）
    setConfig({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } })
    // Then: 下一次解析即拿到 okx 服务，不重启进程、不依赖 watch
    expect(registry.active('crypto')?.service).toBe(okx)
    expect(registry.active('crypto')?.provider).toBe('okx')
  })

  it('选中了但未注册 → undefined（不静默降级到别家）；注销函数生效', () => {
    const { registry, setConfig } = setup()
    const binance = fakeService('binance')
    const unregister = registry.register('crypto', 'binance', binance)
    setConfig({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } })
    expect(registry.active('crypto')).toBeUndefined() // okx 未注册，不回落 binance
    unregister()
    setConfig({ markets: { ...DEFAULT_MARKETS } })
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

describe('TradeRegistryService（tradingTradeRegistry，2026-09-04 补齐 provide 方）', () => {
  const fakeTrade = (tag: string): TradeService => ({
    placeOrder: async (req) => ({
      id: tag, symbol: req.symbol, side: req.side, type: req.type,
      status: 'filled', quantity: req.quantity, dryRun: true, timestamp: 0,
    }),
    cancelOrder: async () => {},
    getOrder: async (_symbol, id) => ({
      id, symbol: _symbol, side: 'buy', type: 'limit', status: 'new', quantity: 1, dryRun: true, timestamp: 0,
    }),
    getPositions: async () => [],
  })
  const setup = () => {
    const box = mutableRef({ markets: { ...DEFAULT_MARKETS } })
    const router = new MarketRouterService(new CordisContext() as never, box.ref)
    const registry = new TradeRegistryService(new CordisContext() as never, router)
    return { router, registry, setConfig: (next: ConfigType) => box.set(next) }
  }

  it('按路由解析激活交易服务；重复注册同 (market,provider) 不同实例抛错', () => {
    const { registry } = setup()
    const binance = fakeTrade('binance')
    const okx = fakeTrade('okx')
    registry.register('crypto', 'binance', binance)
    registry.register('crypto', 'okx', okx)
    expect(registry.active('crypto')?.service).toBe(binance)
    expect(registry.list('crypto').map((e) => e.provider).sort()).toEqual(['binance', 'okx'])
    expect(() => registry.register('crypto', 'binance', fakeTrade('binance-2'))).toThrow(/duplicate trade registration/)
  })

  it('tradeProvider 显式设置时优先于数据面 provider（数据/交易分离预留语义）', () => {
    const { registry, setConfig } = setup()
    const binance = fakeTrade('binance')
    const okx = fakeTrade('okx')
    registry.register('crypto', 'binance', binance)
    registry.register('crypto', 'okx', okx)
    setConfig({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'binance', tradeProvider: 'okx' } } })
    expect(registry.active('crypto')?.service).toBe(okx)
  })

  it('选中了但未注册 → undefined（不静默降级）；注销函数生效', () => {
    const { registry, setConfig } = setup()
    const binance = fakeTrade('binance')
    const unregister = registry.register('crypto', 'binance', binance)
    setConfig({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } })
    expect(registry.active('crypto')).toBeUndefined()
    unregister()
    setConfig({ markets: { ...DEFAULT_MARKETS } })
    expect(registry.active('crypto')).toBeUndefined()
  })

  it('router 无该市场路由：恰好一个注册项 → 零配置可用；多个 → undefined', () => {
    const { registry } = setup()
    const jp = fakeTrade('jp-trade')
    registry.register('jp', 'jp-trade', jp)
    expect(registry.active('jp')?.service).toBe(jp)
    registry.register('jp', 'jp-trade-2', fakeTrade('jp2'))
    expect(registry.active('jp')).toBeUndefined()
  })
})

describe('MarketRouterService（tradingMarketRouter）', () => {
  it('用户切换数据源后行情读取即刻取到新 provider（volatile 引用热更新，无重启）', () => {
    // Given: 路由服务持有 volatile 引用，组合默认 crypto=binance
    const box = mutableRef(ENTRY)
    const svc = new MarketRouterService(new CordisContext() as never, box.ref)
    expect(svc.activeProvider('crypto')).toBe('binance')
    // When: 设置保存提交新快照（loader 原地推进同一引用）
    box.set({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } })
    // Then: 下一次读取即是新 provider
    expect(svc.activeProvider('crypto')).toBe('okx')
  })

  it('用户部署无 loader 引用时（纯对象直调）路由仍按组合配置解析', () => {
    // Given: 直调形态只提供可 get 的等价引用（单测/工具面）
    const svc = new MarketRouterService(new CordisContext() as never, {
      get: () => ENTRY,
    })
    // When: 读取 crypto 路由
    const provider = svc.activeProvider('crypto')
    // Then: 取到组合默认值，不因缺 loader 引用而失效
    expect(provider).toBe('binance')
  })

  it('用户反复切换数据源时只对真实变化通知 watchers（未变不通知、dispose 后静默）', () => {
    // Given: 已注册 watcher，首次 notify 记录 undefined→默认值的 diff
    const box = mutableRef({ markets: { ...DEFAULT_MARKETS } })
    const svc = new MarketRouterService(new CordisContext() as never, box.ref)
    const events: Array<[string | undefined, string | undefined]> = []
    const dispose = svc.watch((next, prev) => events.push([next, prev]))
    svc.notify()
    expect(events.filter(([next]) => next === 'binance')).toHaveLength(1)
    const cryptoFirst = events.find(([, prev]) => prev === undefined && events[0]?.[0] === 'binance')
    expect(cryptoFirst).toEqual(['binance', undefined])
    // When: 配置未变时再次 notify，随后把 crypto 改成 okx
    events.length = 0
    svc.notify()
    expect(events).toHaveLength(0)
    box.set({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } })
    svc.notify()
    // Then: 只有真实变化产生一条 binance→okx 通知；dispose 后不再通知
    expect(events).toContainEqual(['okx', 'binance'])
    dispose()
    box.set({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'binance' } } })
    svc.notify()
    const before = events.length
    expect(events).toHaveLength(before)
  })

  it('用户保存 CryptoPanic key 后新闻读面即刻取到新值（WS2c）', () => {
    // Given: 未配置 key 的路由服务
    const box = mutableRef({ markets: { ...DEFAULT_MARKETS } })
    const svc = new MarketRouterService(new CordisContext() as never, box.ref)
    expect(svc.newsKey()).toBeUndefined()
    // When: 设置保存写入 news.cryptoPanicKey
    box.set({ markets: { ...DEFAULT_MARKETS }, news: { cryptoPanicKey: 'sec_xxx' } })
    // Then: newsKey 读到新值
    expect(svc.newsKey()).toBe('sec_xxx')
  })

  it('用户保存每市场启用源后读面取到该市场清单，未配置市场仍为未配置（issue #96）', () => {
    // Given: 未配置启用源的路由服务（undefined = kit 默认源全集）
    const box = mutableRef({ markets: { ...DEFAULT_MARKETS } })
    const svc = new MarketRouterService(new CordisContext() as never, box.ref)
    expect(svc.newsSources('cn')).toBeUndefined()
    // When: 设置保存 cn 市场只启用 eastmoney
    box.set({ markets: { ...DEFAULT_MARKETS }, news: { sources: { cn: ['eastmoney'] } } })
    // Then: cn 读到该清单，us 仍为未配置（不串市场）
    expect(svc.newsSources('cn')).toEqual(['eastmoney'])
    expect(svc.newsSources('us')).toBeUndefined()
  })

  it('用户在设置页保存后宿主 volatile-update 事件驱动路由 watchers 通知（0.1.7 保存路径）', () => {
    // Given: apply 完成（服务已 provide）且宿主事件回调已被捕获
    const events: Array<[string | undefined, string | undefined]> = []
    const ctx = new CordisContext()
    const box = mutableRef({ markets: { ...DEFAULT_MARKETS } })
    let volatileUpdate: (() => void) | undefined
    ;(ctx as unknown as { on: (event: string, cb: () => void) => void }).on = (event, cb) => {
      if (event === 'loader/volatile-update') volatileUpdate = cb
    }
    apply(ctx as never, box.ref as never)
    const router = (ctx as unknown as { get: (key: string) => MarketRouterService | undefined }).get('tradingMarketRouter')
    if (router !== undefined) router.watch((next, prev) => events.push([next, prev]))
    expect(volatileUpdate).toBeInstanceOf(Function)
    // When: 设置保存提交新快照后宿主 emit loader/volatile-update
    box.set({ markets: { ...DEFAULT_MARKETS, crypto: { provider: 'okx' } } })
    volatileUpdate!()
    // Then: watcher 收到 crypto 的 okx 变化（fresh 进程下 prev 为 undefined）
    expect(events).toContainEqual(['okx', undefined])
  })
})

describe('TradingNewsRegistryService（tradingNewsRegistry，Issue #37）', () => {
  const fakeAggregator = (tag: string): NewsAggregator => async () => ({
    items: [{ source: tag, title: `${tag} title`, url: `https://${tag}.com`, publishedAt: new Date().toISOString() }],
    unavailable: [],
  })

  it('independent role registrations survive sibling disposal and restore previous provider', () => {
    const registry = new TradingNewsRegistryService(new CordisContext() as never)
    const shared = fakeAggregator('shared')
    const other = fakeAggregator('other')
    const first = registry.register('us', shared)
    const second = registry.register('us', shared)
    first()
    first()
    expect(registry.get('us')).toBe(shared)
    const third = registry.register('us', other)
    expect(registry.get('us')).toBe(other)
    third()
    expect(registry.get('us')).toBe(shared)
    second()
    expect(registry.get('us')).toBeUndefined()
  })

  it('注册聚合器、get 获取、markets 列举及注销清理', () => {
    const registry = new TradingNewsRegistryService(new CordisContext() as never)
    const cryptoAgg = fakeAggregator('crypto')
    const usAgg = fakeAggregator('us')

    const unregisterCrypto = registry.register('crypto', cryptoAgg)
    registry.register('us', usAgg)

    expect(registry.get('crypto')).toBe(cryptoAgg)
    expect(registry.get('us')).toBe(usAgg)
    expect(registry.get('cn')).toBeUndefined()
    expect(registry.markets().sort()).toEqual(['crypto', 'us'])

    unregisterCrypto()
    expect(registry.get('crypto')).toBeUndefined()
    expect(registry.markets()).toEqual(['us'])
  })
})

