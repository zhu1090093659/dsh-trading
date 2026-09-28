/**
 * @dshtrading/router —— 市场/数据源路由插件（host 面，市场无关共享行，base 拥有）。
 *
 * 职责（docs/exchange-routing.md §2 定稿）：
 * - expose `dshtrading` 设置面（用户设置一级：markets.<market>.provider）。
 *   0.1.7 起 settings 由 loader 行配置承载：本行（id dsh-trading-market-router）
 *   的 Config 即设置 schema，设置页按行 id 寻址读写；字段须标 volatile 才可
 *   在设置页保存（SettingsForms.write 的 isVolatilePath 闸门）。
 * - provide `tradingMarketRouter` 服务：连接器 apply 时 consult
 *   `activeProvider(market)`——设置选谁谁激活。无 router 的旧部署连接器回退
 *   enabled 语义（向后兼容）。
 * - 保存路径（0.1.7）：设置页写入 → SettingsForms.write → configEditor.edit →
 *   loader volatile-only 更新（字段标了 volatile，不重载插件）→ 宿主 emit
 *   `loader/volatile-update` → 本插件 diff provider 并通知 watchers；数据面
 *   经 MarketDataRegistryService 按最新路由惰性解析，GUI 热切换即刻生效。
 *
 * 兼容性设计（§2.4）：
 * - markets 用 Schema.dict —— 新市场 = 新键，schema 零改；
 * - provider enum = 全仓候选集（binance/okx/yahoo/stooq/tencent），新交易所 = enum 加候选；
 * - 数据/交易分离（tradeProvider）：字段已就位且**已生效**——activeTradeProvider =
 *   tradeProvider ?? provider，TradeRegistryService 按它裁决（2026-09-04 起；
 *   2026-09-08 issue #86 文档修正，此前头注写「预留不实现」与代码不符）。
 *
 * @module @dshtrading/router
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cosmokit'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

import type {
  MarketDataRegistration,
  MarketDataRegistry as MarketDataRegistryContract,
  MarketDataService,
  MarketRouterService as MarketRouterServiceContract,
  NewsAggregator,
  TradeRegistration,
  TradeRegistry as TradeRegistryContract,
  TradeService,
} from '@dshtrading/api'
import { createInstrumentsSearchTool, createRoutingGetTool, type RouterToolServices } from './tools.ts'

/**
 * Cordis 插件名 = patch 行 id：市场无关共享行，base 拥有（铁律 #1/#4）。
 * 全仓唯一，绝不使用 `base` 等官方保留 id（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-market-router'

/* ------------------------------------------------------------------ */
/* 配置（= settings namespace 的 schema，也是本插件的组合 entry）              */
/* ------------------------------------------------------------------ */

/**
 * 内置 provider 词汇表（slug = 路由层词汇，非包名/行 id）——**仅供 UI 展示与
 * 运行时告警，不再是 schema 层硬门槛**（2026-08-30 开放化，架构评审整改 #4）：
 * schema 接受任意字符串 slug，第三方连接器注册同名 slug + 用户设置同名值即可
 * 上榜，不需要改本仓任何代码。未知 slug 的代价 = router 启动/变更时 log warn +
 * 无任何连接器激活（fail-soft），不写时拒。
 */
export const PROVIDER_VOCABULARY = [
  'binance',
  'okx',
  'bybit',
  'ccxt',
  'yahoo',
  'stooq',
  'alpaca',
  'fmp',
  'finnhub',
  'polygon',
  'ibkr',
  'tencent',
  'eastmoney',
  'tushare',
  'akshare',
  'qmt',
  'futu',
  'longbridge',
  'tiger',
  'hithink',
  'jin10',
  'xysz',
] as const
export type Provider = (typeof PROVIDER_VOCABULARY)[number]

export interface MarketProviderEntry {
  /** 该市场当前激活的数据/交易所提供方（连接器 consult 这个值决定激活与否）。开放词汇。 */
  provider: string
  /** 预留：数据面与交易面分离时的交易提供方（不实现，仅类型面占位，见 §2.4）。 */
  tradeProvider?: string
}

export interface NewsConfig {
  /** 可选：CryptoPanic API token（WS2c，#4）。有值时 crypto_get_news 走 CryptoPanic 免费层增强；无值/无效则优雅降级到公共源。 */
  cryptoPanicKey?: string
  /**
   * 可选：各市场启用的新闻/公告源 id 列表（issue #96，方案A 源配置化）。
   * 键 = 市场（cn/us/hk/crypto，开放键），值 = 源 id 数组（各 kit NewsSource 词汇）。
   * 市场键缺省 = 用该 kit 全部默认源；空数组 = 显式关闭该市场新闻。
   */
  sources?: Record<string, string[]>
}

export interface Config {
  /** 各市场数据提供方；dict 键开放（新市场 = 新键，schema 零改）。 */
  markets: Record<string, MarketProviderEntry>
  /** 各提供方 API 凭证（apiKey / apiSecret / token / gatewayUrl 等；dict 开放）。 */
  credentials?: Record<string, Record<string, string>>
  /** 新闻相关设置（WS2c）：默认无 key（公共源）。 */
  news?: NewsConfig
  /**
   * 涨跌配色：red-up = 红涨绿跌（国内习惯），green-up = 绿涨红跌（国际习惯）。
   * 声明在 schema 里才进 describe 投影（0.1.7 SettingsForms 只投影 schema 声明
   * 的字段）——否则设置页写入能落盘、读回却永远缺该字段，radio 无法回显。
   */
  colorMode?: 'red-up' | 'green-up'
}

export const DEFAULT_MARKETS: Record<string, MarketProviderEntry> = {
  crypto: { provider: 'binance' },
  us: { provider: 'yahoo' },
  cn: { provider: 'tencent' },
  hk: { provider: 'tencent' },
  // 期货（issue #97）：唯一 provider 为同花顺（日K + 当日分时；无实盘交易面）。
  futures: { provider: 'hithink' },
  // 全球品种（2026-09-13 金十接入）：唯一 provider 为金十数据 MCP（分钟K + 报价 +
  // 品种代码表；快讯/资讯/财经日历同源）。纯数据市场，无交易面（不开下单工具）。
  global: { provider: 'jin10' },
}

const MarketProviderEntrySchema = Schema.object({
  // 开放字符串（2026-08-30 整改 #4）：第三方 provider slug 不被 schema 一票否决；
  // 已知候选校验下沉到设置 UI 候选清单 + router 运行时 warn（见 apply 内
  // warnUnknownProviders）。
  provider: Schema.string(),
  // 预留字段：数据/交易分离（§2.4）；schemastery 无 .optional() 方法——default undefined 允许缺省。
  tradeProvider: Schema.string().default(undefined),
})

/**
 * 0.1.7 起整个 Config 标记 volatile（llm-pi-ai 同款，官方 host 包先例）：
 * - 0.1.7 的 settings 面只允许写 volatile 声明的字段（SettingsForms.write 的
 *   isVolatilePath 闸门），不标 = 设置页保存必被拒（「保存不了」的根因之一）；
 * - volatile 的运行时值是 cosmokit VolatileRef（引用），插件持有引用、
 *   .get() 惰性取当前快照，并在 `loader/volatile-update` 事件里刷新派生
 *   状态（0.1.5 世代 installSection 的 setSource/onChange 钩子已随该代
 *   settings 面删除）。
 */
// 0.1.7：volatile() 把返回类型投成 Volatile 包装（运行时是引用），与
// Schema<Config>（纯数据形态）不再兼容——声明面放宽为 Schema<any>，读取面
// 由 RouterConfigView 收窄（tsconfig exactOptionalPropertyTypes 下 VolatileSnapshot
// 的 readonly 数组与 Config 的可变数组天然不合）。
export const Config: Schema<any> = Schema.object({
  // 默认值用字面量对象（不用函数——该 schemastery 版本 dict 的 default 函数与 loader 解析
  // 不兼容）→ settings resolver 在用户文档缺失时输出完整默认 markets（critical：
  // resolved 值没有默认时 = {}，路由会判不出任何 provider）。
  markets: Schema.dict(MarketProviderEntrySchema).default({ ...DEFAULT_MARKETS }),
  // credentials 可选：各 provider 的 API Key/Secret/Token/Gateway 地址字典
  credentials: Schema.dict(Schema.dict(Schema.string())).default({}),
  // news 可选（WS2c）：默认空对象 = 无 key = 公共源；字段在时 settings UI 可展示/编辑。
  news: Schema.object({
    cryptoPanicKey: Schema.string().default(undefined),
    // 每市场启用源 id 列表（issue #96）：市场键开放；键缺省 = kit 默认源全集。
    sources: Schema.dict(Schema.array(Schema.string())).default({}),
  }).default({}),
  // 涨跌配色（2026-08-31 全局设置）：settings UI 的 radio 写本键；默认 red-up 保持
  // 现状零变化。必须声明在 schema —— 0.1.7 的 describe 只投影 schema 声明字段，
  // 未声明的写入能落盘但读不回，radio 会永远停在默认值。
  colorMode: Schema.string().default('red-up'),
}).volatile()

/**
 * 设置页寻址 id（0.1.7）：客户端 configForms.get(<id>) 与服务端
 * SettingsForms.write 的 ns 都使用 loader 行 id（entry.options.id），不再是
 * 自由 namespace 字符串。本行 id = dsh-trading-market-router（base patch 拥有）。
 * SETTINGS_NAMESPACE 保留为兼容导出（旧文档/测试引用），运行时不再参与寻址。
 */
export const SETTINGS_NAMESPACE = 'dshtrading' as SettingsNamespace
export const SETTINGS_ENTRY_ID = 'dsh-trading-market-router'

/* ------------------------------------------------------------------ */
/* MarketRouterService（provide 到 tradingMarketRouter）                    */
/* ------------------------------------------------------------------ */

/**
 * 已解析（volatile 剥离后）的配置快照形态：cosmokit 的 VolatileSnapshot 把
 * 嵌套数组投成 readonly，与 Config 的可变数组类型不合——路由面只读，收窄到
 * 本服务实际消费的字段形状即可（news.sources 消费方按 readonly string[] 兼容）。
 */
interface RouterConfigView {
  markets: Record<string, MarketProviderEntry>
  credentials?: Record<string, Record<string, string>>
  news?: { cryptoPanicKey?: string; sources?: Readonly<Record<string, readonly string[]>> }
}

export class MarketRouterService extends Service implements MarketRouterServiceContract {
  // 0.1.7 volatile 契约：Config 整体解析为 cosmokit VolatileRef（引用），插件
  // 持有引用、按需 .get() 取当前不可变快照；写路径由 settings 面经 loader 的
  // volatile-only 更新提交进同一引用（_commitVolatile → updateVolatile），
  // 快照指针前进后本服务的惰性读取自然看到新值。TS 编译期 private 而非
  // ECMAScript #（realm 代理按类身份校验，README 定稿 5）。
  private readonly source: Volatile<RouterConfigView>
  private readonly watchers = new Set<(next: string | undefined, prev: string | undefined) => void>()
  private last: Record<string, string | undefined> = {}

  constructor(ctx: Context, source: Volatile<RouterConfigView>) {
    super(ctx, 'tradingMarketRouter')
    this.source = source
  }

  /** 当前已解析配置快照（volatile 引用的不可变视图；每次读取取最新）。 */
  snapshot(): RouterConfigView {
    return this.source.get() as RouterConfigView
  }

  /** 某市场当前激活的 provider slug（settings resolved：用户层赢，缺省 base 默认）。 */
  activeProvider(market: string): string | undefined {
    return this.snapshot().markets[market]?.provider
  }

  /**
   * 某市场当前激活的**交易面** provider slug（TradeRegistryService 裁决用）：
   * tradeProvider 显式设置（数据/交易分离）时优先；否则与数据面同 provider
   * （§2.4 字段预留语义——连接器交易面 slug 与数据面一致是现状常态）。
   */
  activeTradeProvider(market: string): string | undefined {
    const entry = this.snapshot().markets[market]
    return entry?.tradeProvider ?? entry?.provider
  }

  /** 获取某提供方的 API 凭证字典（如 apiKey、apiSecret 等）。 */
  getCredential(provider: string): Record<string, string> | undefined {
    return this.snapshot().credentials?.[provider]
  }

  /** WS2c：CryptoPanic API token（settings resolved；缺省 undefined = 无 key = 新闻走公共源）。 */
  newsKey(): string | undefined {
    return this.snapshot().news?.cryptoPanicKey
  }

  /** 某市场启用的新闻/公告源 id 列表（issue #96；缺省 undefined = 该 kit 默认源全集）。 */
  newsSources(market: string): readonly string[] | undefined {
    return this.snapshot().news?.sources?.[market]
  }

  /** 订阅激活变化（volatile-update 驱动；restart 型当前仅记录，未来 live 用）。 */
  watch(cb: (next: string | undefined, prev: string | undefined) => void): () => void {
    this.watchers.add(cb)
    return () => { this.watchers.delete(cb) }
  }

  /** 内用：volatile-update 后 diff 并通知 watchers（通知在 watch 后注册的同步回调）。 */
  notify(): void {
    const source = this.snapshot()
    const next: Record<string, string | undefined> = {}
    for (const [market, entry] of Object.entries(source.markets)) next[market] = entry.provider
    for (const [market, provider] of Object.entries(next)) {
      const prev = this.last[market]
      if (prev !== provider) {
        for (const cb of this.watchers) void cb(provider, prev)
      }
    }
    this.last = next
  }
}

/** SDK 服务键（与 @dshtrading/api 的 Context 模块增强一致）。 */
export const TRADING_MARKET_ROUTER_KEY = 'tradingMarketRouter'

/* ------------------------------------------------------------------ */
/* MarketDataRegistryService（provide 到 tradingMarketDataRegistry）        */
/* ------------------------------------------------------------------ */

/**
 * 行情服务注册表（2026-08-30 注册表模式定稿，架构评审整改 #1）：
 * 连接器 host 面数据行全部注册进本表（不再互斥式 provide 市场键），
 * 激活解析 = 本表按 router 当前值惰性裁决——settings 变更即刻生效
 *（GUI 热切换，修复「会话面新建会话生效、GUI 面须重启进程」的语义裂口）。
 *
 * 与 router 同插件同 fiber 提供：base patch 行零改动，生命周期随行。
 */
export class MarketDataRegistryService extends Service implements MarketDataRegistryContract {
  // TS 编译期 private（realm 代理按类身份校验，README 定稿 5）。
  private readonly entries = new Map<string, MarketDataRegistration>()

  constructor(ctx: Context, private readonly router: MarketRouterService) {
    super(ctx, TRADING_MARKET_DATA_REGISTRY_KEY)
  }

  private static keyOf(market: string, provider: string): string {
    return market + ' ' + provider
  }

  register(market: string, provider: string, service: MarketDataService): () => void {
    const key = MarketDataRegistryService.keyOf(market, provider)
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.service !== service) {
      // 配置错误必须响亮：同 (market, provider) 两个服务实例 = bundle patch 重复挂行。
      throw new Error('[dsh-trading-market-router] duplicate market data registration: ' + market + '/' + provider)
    }
    const registration: MarketDataRegistration = { market, provider, service }
    this.entries.set(key, registration)
    return () => {
      if (this.entries.get(key) === registration) this.entries.delete(key)
    }
  }

  active(market: string): MarketDataRegistration | undefined {
    const routed = this.router.activeProvider(market)
    if (routed !== undefined) {
      // 用户设置是权威：选中了但未注册（包未装/enabled=false）→ undefined，
      // 不静默降级到别家（调用方面向用户报「provider 未安装/未激活」）。
      return this.entries.get(MarketDataRegistryService.keyOf(market, routed))
    }
    // router 无该市场路由（新市场键/未知市场）：恰好一个注册项 → 零配置可用；
    // 多个注册项无法裁决 → undefined（用户须在 settings 里显式选择）。
    const all = this.list(market)
    return all.length === 1 ? all[0] : undefined
  }

  list(market: string): readonly MarketDataRegistration[] {
    return [...this.entries.values()].filter((entry) => entry.market === market)
  }
}

/** 注册表服务键（与 @dshtrading/api 的 Context 模块增强一致）。 */
export const TRADING_MARKET_DATA_REGISTRY_KEY = 'tradingMarketDataRegistry'

/** 连接器/桥侧最小形状（不定死接口）。 */
export interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
  active(market: string): MarketDataRegistration | undefined
}

/* ------------------------------------------------------------------ */
/* TradeRegistryService（provide 到 tradingTradeRegistry，issue #40）        */
/* ------------------------------------------------------------------ */

export const TRADING_TRADE_REGISTRY_KEY = 'tradingTradeRegistry'

/**
 * 交易服务注册表（issue #40 契约的本体实现，2026-09-04 补齐缺失的 provide 方）：
 * 与 MarketDataRegistryService 同构——连接器 dataplane 在 host 面把 TradeService
 * 注册进本表，GUI 桥按路由当前值惰性解析。注册面本身不做安全裁决（闸门在
 * 服务缝 placeOrder 三态 + 桥层 dry-run），与 api 包 TradeRegistry 契约注释一致。
 *
 * 路由裁决：markets.<m>.tradeProvider 显式设置时优先，否则回落数据面 provider
 * （§2.4 预留语义）；选中了但未注册 → undefined（不静默降级——用户设置是权威）；
 * router 无该市场路由且恰好一个注册项 → 返回之（新市场零配置可用）。
 */
export class TradeRegistryService extends Service implements TradeRegistryContract {
  private readonly entries = new Map<string, TradeRegistration>()

  constructor(ctx: Context, private readonly router: MarketRouterService) {
    super(ctx, TRADING_TRADE_REGISTRY_KEY)
  }

  private static keyOf(market: string, provider: string): string {
    return market + ' ' + provider
  }

  register(market: string, provider: string, service: TradeService): () => void {
    const key = TradeRegistryService.keyOf(market, provider)
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.service !== service) {
      // 配置错误必须响亮：同 (market, provider) 两个交易服务实例 = bundle patch 重复挂行。
      throw new Error('[dsh-trading-market-router] duplicate trade registration: ' + market + '/' + provider)
    }
    const registration: TradeRegistration = { market, provider, service }
    this.entries.set(key, registration)
    return () => {
      if (this.entries.get(key) === registration) this.entries.delete(key)
    }
  }

  active(market: string): TradeRegistration | undefined {
    const routed = this.router.activeTradeProvider(market)
    if (routed !== undefined) {
      return this.entries.get(TradeRegistryService.keyOf(market, routed))
    }
    // router 无该市场路由（新市场键/未知市场）：恰好一个注册项 → 零配置可用；
    // 多个注册项无法裁决 → undefined（用户须在 settings 里显式选择）。
    const all = this.list(market)
    return all.length === 1 ? all[0] : undefined
  }

  list(market: string): readonly TradeRegistration[] {
    return [...this.entries.values()].filter((entry) => entry.market === market)
  }
}

/* ------------------------------------------------------------------ */
/* TradingNewsRegistry（Issue #37）                                        */
/* ------------------------------------------------------------------ */

export const TRADING_NEWS_REGISTRY_KEY = 'tradingNewsRegistry'

/**
 * 新闻聚合器注册表（Issue #37，与 MarketDataRegistry 同模式）：
 * 各市场 Kit 在 Preset 平面 apply 时向本注册表注册其 aggregateNews 纯函数；
 * GUI 行情桥按路由当前值惰性解析。注册与 Kit 生命周期绑定：
 * Preset 销毁时调用方执行退订函数，该市场新闻自动不可用。
 */
export class TradingNewsRegistryService extends Service {
  private readonly providers = new Map<string, Map<symbol, NewsAggregator>>()

  constructor(ctx: Context) {
    super(ctx, TRADING_NEWS_REGISTRY_KEY)
  }

  /** Kit apply 时注册本市场的新闻聚合器；返回退订函数（Kit dispose 时自动清理）。 */
  register(market: string, aggregator: NewsAggregator): () => void {
    const token = Symbol(market)
    const registrations = this.providers.get(market) ?? new Map<symbol, NewsAggregator>()
    registrations.set(token, aggregator)
    this.providers.set(market, registrations)
    return () => {
      registrations.delete(token)
      if (registrations.size === 0 && this.providers.get(market) === registrations) this.providers.delete(market)
    }
  }

  /** Bridge 分发时取该市场的聚合器；未注册 → undefined（该市场新闻不可用）。 */
  get(market: string): NewsAggregator | undefined {
    const registrations = this.providers.get(market)
    return registrations ? [...registrations.values()].at(-1) : undefined
  }

  /** 全部已注册市场。 */
  markets(): string[] {
    return [...this.providers.keys()]
  }
}

/** 连接器/桥侧最小形状（鸭式）。 */
export interface TradingNewsRegistryLike {
  register(market: string, aggregator: NewsAggregator): () => void
  get(market: string): NewsAggregator | undefined
}

/**
 * 解析注册表服务的辅助（连接器 dataplane 与行情桥使用）：
 * 拿不到（老部署 base/router 未升级）→ undefined，调用方回退旧的直接 provide 路径。
 */
export function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string) => unknown }).get?.(TRADING_MARKET_DATA_REGISTRY_KEY)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                                */
/* ------------------------------------------------------------------ */

/** 连接器侧最小形状（api 包 MarketRouterService 的同构声明；不定死接口）。 */
export interface MarketRouterLike {
  activeProvider(market: string): string | undefined
}

/**
 * 解析路由服务的辅助（连接器 apply 使用；ctx.get 的形态随 cordis 面，与 tools 同规则）：
 * 拿不到（无 router / 未 inject）→ undefined，调用方回退 enabled 语义（向后兼容）。
 */
export function resolveMarketRouter(ctx: Context): MarketRouterLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string) => unknown }).get?.(TRADING_MARKET_ROUTER_KEY)
  return candidate !== undefined ? (candidate as MarketRouterLike) : undefined
}

/** 宿主 logger 的最小形状（ctx.logger(name) 不可用时回落 console）。 */
interface LogLike {
  warn: (...args: unknown[]) => void
}

function logger(ctx: Context): LogLike {
  const service = (ctx as unknown as { logger?: (name: string) => LogLike }).logger
  return typeof service === 'function' ? service(name) : console
}

/**
 * 开放词汇的运行时校验（整改 #4）：schema 不再拒未知 slug，改为 warn + fail-soft
 * （无匹配连接器注册即无激活）。已知词汇仅供此告警与设置 UI 候选清单。
 * 返回未知 slug 清单（测试可直证）。
 */
export function warnUnknownProviders(config: RouterConfigView, log: LogLike): string[] {
  const known = new Set<string>(PROVIDER_VOCABULARY)
  const unknown: string[] = []
  for (const [market, entry] of Object.entries(config.markets)) {
    for (const slug of [entry.provider, entry.tradeProvider]) {
      if (slug !== undefined && !known.has(slug) && !unknown.includes(slug)) unknown.push(slug)
    }
    if (entry.provider !== undefined && !known.has(entry.provider)) {
      log.warn(
        '[dsh-trading-market-router] unknown provider slug %s for market %s — '
        + 'no built-in connector will activate; this is only valid if a third-party '
        + 'connector registers the same slug (see docs/connector-playbook.md)',
        entry.provider, market,
      )
    }
  }
  return unknown
}

export function apply(ctx: Context, config: Config): void {
  // 0.1.7：Config 标 volatile 后，loader 传进 apply 的 config 是 cosmokit
  // VolatileRef（引用，见 Config 头注）。这里直接把引用交给
  // MarketRouterService 持有；每次 activeProvider()/getCredential() 等读取时
  // 经 snapshot() 取最新不可变快照——settings 面保存后 loader 的
  // volatile-only 更新会推进同一引用，读取即见新值，无需重启。
  const service = new MarketRouterService(ctx, toVolatile(config))
  // 注册表与 router 同 fiber 提供：base patch 行零改动。
  const registry = new MarketDataRegistryService(ctx, service)
  // 交易注册表（issue #40 契约）同 fiber 提供——2026-09-04 修复：此前只有契约与消费方、
  // 没有 provide 方，dataplane 与桥 ctx.get 恒 undefined，抽屉永远显示凭证提示。
  new TradeRegistryService(ctx, service)
  // 新闻注册表与 router/registry 同 fiber 提供（Issue #37）；Service 构造即自 provide。
  new TradingNewsRegistryService(ctx)
  const log = logger(ctx)
  warnUnknownProviders(service.snapshot(), log)

  // routing_get / instruments_search（issue #33 / P4，host 平面，全会话可见 D4）。
  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (!tools || typeof tools.register !== 'function') return
    const services: RouterToolServices = {
      activeProvider: (market) => service.activeProvider(market),
      registry: { active: (market) => registry.active(market) },
    }
    for (const tool of [createRoutingGetTool(services), createInstrumentsSearchTool(services)]) {
      if (tools.get(tool.name) === undefined) tools.register(tool)
    }
  })

  // 0.1.7 volatile 热更新：settings 保存经 loader 的 volatile-only 更新提交后，
  // 宿主 emit loader/volatile-update。这里 diff provider 变化并通知 watchers
  // （取代 0.1.5 世代 installSection 的 setSource/onChange 接线——两个钩子已随
  // 该代 settings 面删除）。settings 缺失（老部署未挂）时本事件不会到，
  // 服务仍按组合配置常驻，路由不失效。
  ctx.on('loader/volatile-update' as never, (() => {
    warnUnknownProviders(service.snapshot(), log)
    service.notify()
  }) as never)
}

/**
 * 把插件 apply 收到的 config 归一为 volatile 引用面：
 * 0.1.7 loader 传 VolatileRef（有 .get()）；单测/工具直调传纯对象（无 .get()），
 * 包一层等价引用，两种形态共用同一条读取路径。
 */
function toVolatile(config: Config): Volatile<RouterConfigView> {
  const candidate = config as unknown as { get?: unknown }
  if (typeof candidate?.get === 'function') return config as unknown as Volatile<RouterConfigView>
  return { get: () => config as unknown as RouterConfigView }
}

/** 供测试/连接器单测使用的纯函数：给定 Config 返回市场路由判定。 */
export function activeProviderOf(config: Config, market: string): string | undefined {
  return config.markets[market]?.provider
}
