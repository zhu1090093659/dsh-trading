/**
 * @dsh-trading/router —— 市场/数据源路由插件（host 面，市场无关共享行，base 拥有）。
 *
 * 职责（docs/exchange-routing.md §2 定稿）：
 * - 注册 `dshtrading` settings namespace（用户设置一级：markets.<market>.provider），
 *   分层 = schema 默认 → 组合 base（本轮默认表）→ 用户层（`~/.dsh/settings.yaml`），
 *   用户层赢；base 默认实现「现状零变化」。
 * - provide `tradingMarketRouter` 服务：连接器 apply 时 consult
 *   `activeProvider(market)`——设置选谁谁激活。无 router 的旧部署连接器回退
 *   enabled 语义（向后兼容）。
 * - `applies: 'restart'`：连接器 apply 只在挂载时跑，切交易所后新建会话生效
 *   （preset 挂载是会话级的，无需重启 dsh 进程）。watch 服务面保留，live 热切换
 *   留待后续（需要连接器 re-inject，本轮不做——YAGNI）。
 *
 * 兼容性设计（§2.4）：
 * - markets 用 Schema.dict —— 新市场 = 新键，schema 零改；
 * - provider enum = 全仓候选集（binance/okx/yahoo/stooq/tencent），新交易所 = enum 加候选；
 * - 数据/交易分离（tradeProvider）字段预留不实现（铁律 #4：两个市场真实需要才做）。
 *
 * @module @dsh-trading/router
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

import type {
  MarketDataRegistration,
  MarketDataRegistry as MarketDataRegistryContract,
  MarketDataService,
  MarketRouterService as MarketRouterServiceContract,
} from '@dsh-trading/api'

/**
 * Cordis 插件名 = patch 行 id：市场无关共享行，base 拥有（铁律 #1/#4）。
 * 全仓唯一，绝不使用 `base` 等官方保留 id（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-market-router'

/* ------------------------------------------------------------------ */
/* 配置（= settings namespace 的 schema，也是本插件的组合 entry）              */
/* ------------------------------------------------------------------ */

/** 全仓 provider 候选集（slug = 路由层词汇，非包名/行 id）。 */
export const PROVIDER_VOCABULARY = ['binance', 'okx', 'yahoo', 'stooq', 'tencent'] as const
export type Provider = (typeof PROVIDER_VOCABULARY)[number]

export interface MarketProviderEntry {
  /** 该市场当前激活的数据/交易所提供方（连接器 consult 这个值决定激活与否）。 */
  provider: Provider
  /** 预留：数据面与交易面分离时的交易提供方（不实现，仅类型面占位，见 §2.4）。 */
  tradeProvider?: Provider
}

export interface Config {
  /** 各市场数据提供方；dict 键开放（新市场 = 新键，schema 零改）。 */
  markets: Record<string, MarketProviderEntry>
}

export const DEFAULT_MARKETS: Record<string, MarketProviderEntry> = {
  crypto: { provider: 'binance' },
  us: { provider: 'yahoo' },
  cn: { provider: 'tencent' },
  hk: { provider: 'tencent' },
}

const MarketProviderEntrySchema = Schema.object({
  provider: Schema.union(PROVIDER_VOCABULARY),
  // 预留字段：数据/交易分离（§2.4）；schemastery 无 .optional() 方法——default undefined 允许缺省。
  tradeProvider: Schema.union(PROVIDER_VOCABULARY).default(undefined),
})

export const Config: Schema<Config> = Schema.object({
  // 默认值用字面量对象（不用函数——该 schemastery 版本 dict 的 default 函数与 loader 解析
  // 不兼容）→ settings resolver 在用户文档缺失时输出完整默认 markets（critical：
  // installSettingsSection 的 resolved 值没有默认时 = {}，路由会判不出任何 provider）。
  markets: Schema.dict(MarketProviderEntrySchema).default({ ...DEFAULT_MARKETS }),
})

/** settings namespace（kebab-case 品牌化，llm-pi-ai 同款）。 */
export const SETTINGS_NAMESPACE = settingsNamespace('dshtrading')

/* ------------------------------------------------------------------ */
/* MarketRouterService（provide 到 tradingMarketRouter）                    */
/* ------------------------------------------------------------------ */

export class MarketRouterService extends Service implements MarketRouterServiceContract {
  // source thunk 可替换：settings 挂载前 = 组合 entry，挂载后 = resolved scope。
  // TS 编译期 private 而非 ECMAScript #（realm 代理按类身份校验，README 定稿 5）。
  private source: () => Config
  private readonly watchers = new Set<(next: string | undefined, prev: string | undefined) => void>()
  private last: Record<string, Provider | undefined> = {}

  constructor(ctx: Context, source: () => Config) {
    super(ctx, 'tradingMarketRouter')
    this.source = source
  }

  /** settings onChange 时替换权威源（installSettingsSection.setSource 契约）。 */
  setSource(source: () => Config): void {
    this.source = source
  }

  /** 某市场当前激活的 provider slug（settings resolved：用户层赢，缺省 base 默认）。 */
  activeProvider(market: string): Provider | undefined {
    return this.source().markets[market]?.provider
  }

  /** 订阅激活变化（settings commit 驱动；restart 型当前仅记录，未来 live 用）。 */
  watch(cb: (next: string | undefined, prev: string | undefined) => void): () => void {
    this.watchers.add(cb)
    return () => { this.watchers.delete(cb) }
  }

  /** 内用：settings onChange 后 diff 并通知 watchers（通知在 watch 后注册的同步回调）。 */
  notify(): void {
    const source = this.source()
    const next: Record<string, Provider | undefined> = {}
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

/** SDK 服务键（与 @dsh-trading/api 的 Context 模块增强一致）。 */
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

/** 注册表服务键（与 @dsh-trading/api 的 Context 模块增强一致）。 */
export const TRADING_MARKET_DATA_REGISTRY_KEY = 'tradingMarketDataRegistry'

/** 连接器/桥侧最小形状（不定死接口）。 */
export interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
  active(market: string): MarketDataRegistration | undefined
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

export function apply(ctx: Context, config: Config): void {
  // loader 没写官方 config 合并语义时，dict 无默认 → 这里兜底合并 DEFAULT_MARKETS。
  const effective: Config = { markets: { ...DEFAULT_MARKETS, ...(config?.markets ?? {}) } }
  const service = new MarketRouterService(ctx, () => effective)
  // 注册表与 router 同 fiber 提供：base patch 行零改动。
  new MarketDataRegistryService(ctx, service)

  // settings 服务存在时：注册 namespace（base = 组合 entry，用户层赢）+ 源切换
  // + onChange 通知 diff。settings 缺失（老部署未挂）→ 服务照常 provide，
  // 源恒为组合配置（= 现状行为），路由仍然有效。
  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, effective, {
    setSource: (current) => service.setSource(current),
    onChange: () => service.notify(),
  })
}

/** 供测试/连接器单测使用的纯函数：给定 Config 返回市场路由判定。 */
export function activeProviderOf(config: Config, market: string): Provider | undefined {
  return config.markets[market]?.provider
}
