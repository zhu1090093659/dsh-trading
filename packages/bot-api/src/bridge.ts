/**
 * 行情 HTTP 桥的纯逻辑层：请求解析 → 市场服务分发 → 统一 JSON 形状。
 *
 * 设计约束：
 * - 铁律 #5（数据合规）：本桥是无状态透传，不做任何缓存/落盘；频率由客户端轮询
 *   节奏控制，symbols 数量服务端封顶（MAX_SYMBOLS）。
 * - 服务解析 registry-first（2026-08-30 注册表模式，架构评审整改 #1）：每请求经
 *   tradingMarketDataRegistry 按路由当前值惰性解析——settings 切换交易所即刻生效
 *   （GUI 热切换，无 watch 无重启）；注册表缺席或无对应注册项时回退旧的市场键
 *   直读（老部署/连接器未升级）。preset 平面不经本桥（会话隔离）。
 * - 业务错误一律 HTTP 200 + { ok:false, code, message }（错误词汇沿用
 *   TradingErrorCode 惯例）；仅协议层错误用 4xx。
 * - Issue #19：提供 /indicators/custom 端点（GET/DELETE），供前端同步自定义指标。
 * - Issue #24：提供 /knowledge/cards 端点（GET），供前端读取沉淀的知识卡片。
 * - Issue #65：提供 /holdings 七个端点 + /fx 端点（统一资产台账，契约 §3/§4）。
 * - 2026-10-13：提供 /active-buy 端点（cn 主动买盘日频文件序列 + 可选当日 live，只读）。
 * - 2026-10-13：提供 /southbound-holdings 端点（港股通持股副图；按能力跨 provider 解析）。
 * - 2026-10-15：/klines 按连接器声明的 K 线能力跨源解析取数源（active 声明覆盖就用 active），
 *   wire 标注实际供数 provider；/markets 上报同市场能力并集；/tickers 支持显式 provider
 *   （未注册即 400）。
 * - 2026-10-23：/klines 的换源放宽为「结构性缺能力 或 运行时故障」——前者沿候选序走到底，
 *   后者全程最多兜底 1 次；限流/坏符号/交易所业务错误仍原样抛。整段同源、provider 如实标注。
 */
import { instrumentFormOf } from '@dshtrading/api'
import type { ActiveBuySnapshot, AccountBalance, DerivativesData, DerivativesHistory, FundamentalsPackage, InstrumentAssetClass, InstrumentForm, InstrumentRef, Interval, Kline, KlineCapability, MacroCalendarEntry, MacroRateEntry, MarketDataService, NewsAggregator, NewsItem, Order, Orderbook, OrderRequest, Position, PredictionFeed, PredictionMeeting, SouthboundHoldingHistory, StockFundamentals, Ticker, TradeFill, TradeService, TradeTick } from '@dshtrading/api'
import { aggregateNews as aggregateCnNews, fetchCnFundamentalsPackage } from '@dshtrading/kit-cn'
import { aggregateNews as aggregateHkNews, fetchHkFundamentalsPackage } from '@dshtrading/kit-hk'
import { aggregateNews as aggregateUsNews, fetchUsFundamentalsPackage } from '@dshtrading/kit-us'
import { aggregateNews as aggregateCryptoNews, fetchCryptoFundamentalsPackage } from '@dshtrading/kit-crypto'
import type { ChartActivationStore, CustomIndicatorRecord, CustomIndicatorStore, IndicatorApplyScope, IndicatorInstance } from '@dshtrading/indicators'
import { carryInstanceExtras, clampActivationParams, createMemoryChartActivationStore, createMemoryCustomIndicatorStore, defaultActivationInstance, resolveIndicatorSpec, sanitizeApplyScope, sanitizeInstance, symbolScopeKey, withHiddenScopes } from '@dshtrading/indicators'
import type { KnowledgeCard, KnowledgeCardStore } from '@dshtrading/knowledge'
import { createMemoryKnowledgeCardStore } from '@dshtrading/knowledge'
import type { CustomStrategyRecord, CustomStrategyStore } from '@dshtrading/strategies'
import {
  createMemoryCustomStrategyStore,
  createMemoryBuiltinTombstonesStore,
  createMemoryCustomScreenerStore,
  isBuiltinStrategyId,
  isBuiltinScreenerId,
} from '@dshtrading/strategies'
import type { BuiltinTombstonesStore, CustomScreenerRecord, CustomScreenerStore } from '@dshtrading/strategies'
// Node 侧沙箱校验（策略/选股器管理 PUT 落盘前的 vm 熔断试算）；bridge.ts 仅 node 半
// 加载，client 打包不 import 本文件（client 半只经 api.ts 走 HTTP）。
import { validateCustomStrategyNode, validateCustomScreenerNode } from '@dshtrading/strategies/plugin'
import type { SelectionStore, WatchlistGroup, WatchlistGroupsStore, WatchlistInstrument, WatchlistStore, WatchlistsMap } from '@dshtrading/watchlist'
import { createMemorySelectionStore, createMemoryWatchlistGroupsStore, createMemoryWatchlistStore, WATCHLIST_SEEDS } from '@dshtrading/watchlist'
// 统一资产台账（issue #65）：type-only import——@dshtrading/holdings 由并行流建设，
// 缺席时本包 vitest 不受影响（擦除）；运行时 store 走 host 注入 + 本文件内存兜底。
import type { Holding, HoldingCurrency, HoldingMarket, NewHolding, NewHoldingInput } from '@dshtrading/holdings'
import { createMemoryHoldingsStore, HOLDING_MARKETS } from '@dshtrading/holdings'
import type { FxFetchLike } from '@dshtrading/holdings/fx'
import { createFxService } from '@dshtrading/holdings/fx'
import { GuiApprovalDeniedError, type GuiApprovalSeat, type GuiLiveAction } from './gui-approval.ts'
import { TtlCache } from './ttl-cache.ts'
import { mergeActiveBuyPoints, readActiveBuySnapshots, shanghaiDate, type ActiveBuyWire } from './active-buy.ts'

/** 本桥支持的市场（与连接器服务键一一对应）。 */
export type MarketId = 'crypto' | 'us' | 'cn' | 'hk' | 'futures' | 'global'

export const MARKET_IDS: readonly MarketId[] = ['crypto', 'us', 'cn', 'hk', 'futures', 'global']

/** market → Context 服务键（@dshtrading/api 的 Context 增强）。 */
export const MARKET_SERVICE_KEYS: Record<MarketId, string> = {
  crypto: 'tradingCryptoMarketData',
  us: 'tradingUsMarketData',
  cn: 'tradingCnMarketData',
  hk: 'tradingHkMarketData',
  futures: 'tradingFuturesMarketData',
  global: 'tradingGlobalMarketData',
}

/** 注册表服务的最小形状（鸭式，与 @dshtrading/router 的 MarketDataRegistryLike 同构）。 */
export interface MarketDataRegistryLike {
  active(market: string): { provider: string; service: MarketDataService } | undefined
  /**
   * 该市场全部注册项（可选，2026-10-13 港股通持股副图）：按能力跨 provider 解析时
   * 要看「同市场其它 provider」（本机 hk 的 eastmoney 已注册但非 active，正走这条）。
   * 注册表未提供本方法 → 只认 active 路径，无能力时退化为 TRADING_NOT_IMPLEMENTED。
   */
  list?(market: string): readonly { provider: string; service: MarketDataService }[]
}

/** 交易注册表服务的最小形状（issue #40，鸭式；api 包 TradeRegistry 同构）。 */
export interface TradeRegistryLike {
  active(market: string): { provider: string; service: TradeService } | undefined
}

/** 新闻注册表服务的最小形状（issue #37，鸭式；api 包 TradingNewsRegistry 同构）。 */

/**
 * 快讯源最小结构面（桥侧）：host 面 tradingFlashFeed 服务实现
 * @dshtrading/api 的 FlashFeedService；此处只声明桥用到的两个方法，
 * 避免 shell 包对连接器包的类型依赖。
 */
export interface FlashFeedLike {
  listFlash(options?: { cursor?: string | undefined; limit?: number | undefined; hot?: readonly string[] | undefined }): Promise<{ items: readonly NewsItem[]; nextCursor?: string | undefined; hasMore: boolean }>
  searchFlash(keyword: string, limit?: number | undefined): Promise<readonly NewsItem[]>
}

/**
 * 宏观/利率源最小结构面（桥侧）：host 面 tradingMacroFeed 服务实现
 * @dshtrading/api 的 MacroFeedService；鸭式声明避免 shell 包对连接器包的类型依赖。
 */
export interface MacroFeedLike {
  listCalendar(limit?: number | undefined): Promise<readonly MacroCalendarEntry[]>
  listRates(): Promise<readonly MacroRateEntry[]>
}

/**
 * 预测市场源最小结构面（桥侧）：host 面 tradingPredictionFeed 服务实现
 * @dshtrading/api 的 PredictionFeedService；鸭式声明避免 shell 包对连接器包的类型依赖。
 */
export interface PredictionFeedLike {
  listFomcMeetings(): Promise<PredictionFeed>
}

/** 快讯端点条目上限（保护上游公共配额；超出直接 400）。 */
export const MAX_FLASH_LIMIT = 50

/** 快讯热度等级（金十网页版 火/热/沸/爆；与 connector-jin10 的 JIN10_HEAT_LEVELS 同词汇）。 */
const FLASH_HEAT_LEVELS = ['火', '热', '沸', '爆'] as const

/** 解析 hot 查询参数（逗号分隔）；未知等级 → 400，不静默改变语义。 */
function parseFlashHeat(raw: string | null): string[] {
  if (raw === null) return []
  const levels = raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
  for (const level of levels) {
    if (!(FLASH_HEAT_LEVELS as readonly string[]).includes(level)) {
      throw new BridgeProtocolError(400, `flash: unsupported hot level ${JSON.stringify(level)} (supported: ${FLASH_HEAT_LEVELS.join('/')})`)
    }
  }
  return levels
}

export interface TradingNewsRegistryLike {
  register(market: string, aggregator: NewsAggregator): () => void
  get(market: string): NewsAggregator | undefined
}

/**
 * 桥宿主工厂（registry-first 解析的唯一实现，node 半与单测共用）：
 * - getMarketService：注册表有激活注册项 → 用之；否则回退 legacy 市场键直读
 *   （2026-08-30 前形态：连接器老 dataplane 互斥 provide 市场键的部署）。
 * - activeProvider：优先报告实际供数的注册项 provider；注册表未裁决时回退 router 值
 *   （选中但未注册 → 用户能在 GUI 看到设置目标，行情区报「未安装/未激活」）。
 */
export function createBridgeHost(services: {
  registry?: MarketDataRegistryLike | undefined
  tradeRegistry?: TradeRegistryLike | undefined
  router?: { activeProvider(market: string): string | undefined } | undefined
  legacy(market: MarketId): MarketDataService | undefined
  customIndicatorsStore?: CustomIndicatorStore | undefined
  /** 图表激活名册 store（issue #63，可选）。 */
  chartActivationsStore?: ChartActivationStore | undefined
  knowledgeStore?: KnowledgeCardStore | undefined
  strategyStore?: CustomStrategyStore | undefined
  /** 内置策略/选股器墓碑 store（策略管理，可选）。 */
  tombstonesStore?: BuiltinTombstonesStore | undefined
  /** 自定义选股器 store（选股器管理，可选）。 */
  screenerStore?: CustomScreenerStore | undefined
  watchlistStore?: WatchlistStore | undefined
  /** 自定义分组注册表 store（issue #82；可选）。 */
  groupsStore?: WatchlistGroupsStore | undefined
  selectionStore?: SelectionStore | undefined
  /** 统一资产台账 store（issue #65；缺席 → 进程内内存兜底）。 */
  holdingsStore?: HoldingsStoreLike | undefined
  /** FX 服务（issue #65；缺席 → 桥内兜底 fetcher，契约 §4 减文件缓存）。 */
  fetchFxRates?: FxRatesFetcher | undefined
  /** 新闻注册表（issue #37）。 */
  newsRegistry?: TradingNewsRegistryLike | undefined
  /** CryptoPanic API token 取值函数（从 router settings 获取；可选）。 */
  newsKey?: (() => string | undefined) | undefined
  /** 市场启用的新闻/公告源 id 列表取值函数（issue #96；可选）。 */
  newsSources?: ((market: string) => readonly string[] | undefined) | undefined
  /** 跨市场快讯源（2026-09-13 金十接入；缺席 = 未安装快讯连接器 → TRADING_NOT_IMPLEMENTED）。 */
  flashFeed?: FlashFeedLike | undefined
  /** 宏观/利率源（2026-09-15 金十接入；缺席 = 未安装金十连接器 → TRADING_NOT_IMPLEMENTED）。 */
  macroFeed?: MacroFeedLike | undefined
  /** 预测市场源（2026-10-11 Polymarket 接入；缺席 = 未安装该连接器 → TRADING_NOT_IMPLEMENTED）。 */
  predictionFeed?: PredictionFeedLike | undefined
  /** GUI 实盘动作的逐动作审批座位（2026-10-12；缺席 = 无审批面 → GUI 实盘 fail-closed）。 */
  guiApproval?: GuiApprovalSeat | undefined
}): BridgeHost {
  return {
    getMarketService: market => {
      const active = services.registry?.active(market)
      if (active !== undefined) return active.service
      return services.legacy(market)
    },
    getTradeService: market => services.tradeRegistry?.active(market)?.service,
    activeProvider: market => services.registry?.active(market)?.provider ?? services.router?.activeProvider(market),
    // 注册表本体透传（2026-10-13）：southboundHoldings / klines / tickers 需要 active + list 两条路径。
    marketRegistry: services.registry,
    customIndicatorsStore: services.customIndicatorsStore ?? createMemoryCustomIndicatorStore(),
    chartActivationsStore: services.chartActivationsStore ?? createMemoryChartActivationStore(),
    knowledgeStore: services.knowledgeStore ?? createMemoryKnowledgeCardStore(),
    strategyStore: services.strategyStore ?? createMemoryCustomStrategyStore(),
    tombstonesStore: services.tombstonesStore ?? createMemoryBuiltinTombstonesStore(),
    screenerStore: services.screenerStore ?? createMemoryCustomScreenerStore(),
    watchlistStore: services.watchlistStore ?? createMemoryWatchlistStore(),
    groupsStore: services.groupsStore ?? createMemoryWatchlistGroupsStore(),
    selectionStore: services.selectionStore ?? createMemorySelectionStore(),
    holdingsStore: services.holdingsStore ?? createFallbackHoldingsStore(),
    fetchFxRates: services.fetchFxRates,
    newsRegistry: services.newsRegistry,
    newsKey: services.newsKey,
    newsSources: services.newsSources,
    flashFeed: services.flashFeed,
    macroFeed: services.macroFeed,
    predictionFeed: services.predictionFeed,
    guiApproval: services.guiApproval,
  }
}

/** 单次批量报价的 symbols 封顶（保护公共端点，超出部分直接拒绝）。 */
export const MAX_SYMBOLS = 32

/**
 * 单次 K 线 limit 封顶 = 2500（2026-10-14）：量级取「5 个交易日的 1m 窗口」——
 * 美股常规时段 390 根/日（5 日 1950）、cn 241 根/日（约 1205）、hk 331 根/日（约 1655），
 * 2500 覆盖三者并留余量，让窗口型连接器（雅虎 range=7d、东财 trends2 ndays=5）
 * 有一个能显式表达「五日 1m」的契约上限。这是**参数闸门**而非返回截断：
 * 连接器各自按 limit 截尾或按上游上限回落。
 */
export const MAX_KLINE_LIMIT = 2500

/** 宿主面：桥对 cordis ctx 的最小依赖（便于单测注入假件）。 */
export interface BridgeHost {
  /** 取市场行情服务；未安装/未激活返回 undefined。 */
  getMarketService(market: MarketId): MarketDataService | undefined
  /** 该市场当前激活的 provider slug（router 设置；可能 undefined）。 */
  activeProvider(market: MarketId): string | undefined
  /**
   * 行情服务注册表本体（可选，2026-10-13 港股通持股副图）：southboundHoldings 与
   * klines/tickers 按能力跨 provider 解析时需要 registry.active + registry.list，
   * 而非仅 getMarketService 解析出的那一个（markets 的 klineCapabilities 并集也取自
   * list）。createBridgeHost 已接线；字面量宿主/旧宿主缺席 → 只认 active 路径。
   */
  marketRegistry?: MarketDataRegistryLike | undefined
  /** 自定义指标存储（可选）。 */
  customIndicatorsStore?: CustomIndicatorStore
  /** 图表激活名册存储（可选，issue #63）。 */
  chartActivationsStore?: ChartActivationStore
  /** 知识卡片存储（可选）。 */
  knowledgeStore?: KnowledgeCardStore
  /** 自定义策略存储（可选，issue #31）。 */
  strategyStore?: CustomStrategyStore
  /** 内置策略/选股器墓碑存储（可选，策略管理；createBridgeHost 已兜底内存实现）。 */
  tombstonesStore?: BuiltinTombstonesStore
  /** 自定义选股器存储（可选，选股器管理；createBridgeHost 已兜底内存实现）。 */
  screenerStore?: CustomScreenerStore
  /** 自选股存储（可选，issue #32）。 */
  watchlistStore?: WatchlistStore
  /** 自定义分组注册表存储（可选，issue #82；createBridgeHost 已兜底内存实现）。 */
  groupsStore?: WatchlistGroupsStore
  /** 选中标的存储（可选，issue #32）。 */
  selectionStore?: SelectionStore
  /** 统一资产台账存储（可选，issue #65；createBridgeHost 已兜底内存实现）。 */
  holdingsStore?: HoldingsStoreLike
  /** FX 服务（可选，issue #65；缺席 → 桥内兜底 fetcher）。 */
  fetchFxRates?: FxRatesFetcher | undefined
  /**
   * 交易服务（可选，issue #40）：tradeRegistry 按 market 解析；未注册 → undefined
   * （交易台整体隐藏）。**安全语义（2026-10-12 更新）**：桥可发起真交易，但实盘
   * place/cancel 必须先在宿主 approval 面拿到逐动作授权（缺 intentId、审批缺席、
   * 拒绝、取消或会话不匹配一律明确失败，不回退成模拟成交）；dry-run 仍可直接执行。
   */
  getTradeService?(market: MarketId): TradeService | undefined
  /** 新闻注册表（可选，issue #37）：各市场 Kit 注册的新闻聚合器。 */
  newsRegistry?: TradingNewsRegistryLike | undefined
  /** CryptoPanic API token 取值函数（从 router settings 获取；可选，issue #37）。 */
  newsKey?: (() => string | undefined) | undefined
  /** 市场启用的新闻/公告源 id 列表取值函数（issue #96；缺省 = kit 默认源全集）。 */
  newsSources?: ((market: string) => readonly string[] | undefined) | undefined
  /** 跨市场快讯源（2026-09-13 金十接入；缺席 = 未安装快讯连接器 → TRADING_NOT_IMPLEMENTED）。 */
  flashFeed?: FlashFeedLike | undefined
  /** 宏观/利率源（2026-09-15 金十接入；缺席 = 未安装金十连接器 → TRADING_NOT_IMPLEMENTED）。 */
  macroFeed?: MacroFeedLike | undefined
  /** 预测市场源（2026-10-11 Polymarket 接入；缺席 = 未安装该连接器 → TRADING_NOT_IMPLEMENTED）。 */
  predictionFeed?: PredictionFeedLike | undefined
  /**
   * GUI 实盘动作的逐动作审批座位（2026-10-12 用户裁决：保留 GUI 实盘并接入官方
   * ctx.approval.request）。缺席时 GUI 实盘动作一律 TRADING_APPROVAL_DENIED——
   * 审批面没挂不是放行的理由。
   */
  guiApproval?: GuiApprovalSeat | undefined
}

/** 一条 kline 能力声明（wire 形状；client 半按同一份契约消费）。 */
export interface KlineCapabilityWire {
  interval: string
  maxBars: number
}

export interface MarketInfoWire {
  id: MarketId
  provider?: string
  /**
   * 该市场**全部注册项**声明的 (周期, 深度) 并集（同 interval 取 maxBars 最大值）。
   * 判据是「该市场能不能取到某 (周期, 深度)」，与当前路由无关——路由切换不该让级别
   * 在客户端消失（真去取时由跨源解析兜住）。无任何声明时字段缺席：缺席 = 未声明，
   * 不给空数组冒充「无能力」。
   */
  klineCapabilities?: readonly KlineCapabilityWire[]
}

export type TickerOutcome =
  | { ok: true; ticker: Ticker }
  | { ok: false; code: string; message: string }

/**
 * 批量行形状守卫（fail-closed）：只有非空对象才算「确实拿到了行」。
 * `getTickers` 是公开可选能力、实现质量不在本桥假设内；某实现漏行时返回
 * null/undefined/原始值一律按缺行处理并回落逐只 `getTicker` —— 绝不为凑齐
 * 入参造假值，也绝不把坏值包成 `{ok:true}` 当行情上行给客户端。
 */
function isBatchTicker(value: unknown): value is Ticker {
  return typeof value === 'object' && value !== null
}

export interface MarketsWire {
  markets: MarketInfoWire[]
}

export interface TickersWire {
  tickers: Record<string, TickerOutcome>
}

export interface KlinesWire {
  klines: Kline[]
  /**
   * 本次**实际供数**的 provider slug（2026-10-15 跨源 K 线路由）。跨源后仍是真实来源：
   * 消费方拿它判断「这根 bar 来自哪个源」（如与 ticker 合流前比对来源），不得用它回推路由设置。
   * 解析不到 slug 时省略（老宿主/字面量宿主没有注册表可问）——缺席 ≠ 用了 active。
   */
  provider?: string
}

export interface SymbolInfoWire {
  symbol: string
  name?: string
  /**
   * 形态轴（2026-10-08 加密永续落地，缺省 = 现货）：`-SWAP` 后缀即永续，判据复用
   * `instrumentFormOf`；连接器名册未标注时由本桥按符号兜底（畸形行除外，wire 上恒有值）。
   */
  form?: InstrumentForm
  /** 资产类别（交易所元数据原样透传，取不到即留空，禁止按符号猜）。 */
  assetClass?: InstrumentAssetClass
}

/**
 * 名册行 → wire 行：形态按 api 判据兜底（名册未标注 = 现货），资产类别只做原样透传。
 * 防御性：畸形行（symbol 非字符串）不抛错，形状与既有 `{ symbol }` 兜底一致。
 */
function toSymbolInfoWire(item: InstrumentRef): SymbolInfoWire {
  const symbol = item.symbol
  const form = item.form ?? (typeof symbol === 'string' && symbol !== '' ? instrumentFormOf(symbol) : undefined)
  return {
    symbol,
    ...(item.name ? { name: item.name } : {}),
    ...(form !== undefined ? { form } : {}),
    ...(item.assetClass !== undefined ? { assetClass: item.assetClass } : {}),
  }
}

export interface SymbolsWire {
  symbols: SymbolInfoWire[]
}

export interface FundamentalsWire {
  ok: true
  fundamentals: StockFundamentals
}

/**
 * 港股通持股历史信封（2026-10-13）：字段名 = 方法名/路由名，客户端按
 * payload.southboundHoldings 读取；标的不在港股通范围时 points 为空数组
 * （空 ≠ 0，前端隐藏副图），上游失败则由错误信封承载。
 */
export interface SouthboundHoldingsWire {
  ok: true
  southboundHoldings: SouthboundHoldingHistory
}

/** 实现了港股通持股端点的行情服务（可选能力；连接器选择性实现）。 */
type SouthboundCapableService = MarketDataService & {
  getSouthboundHoldings(symbol: string): Promise<SouthboundHoldingHistory>
}

/** 能力探测（鸭子类型）：只认真正实现了可选方法的服务，缺席/非函数一律不算。 */
function hasSouthboundHoldings(service: MarketDataService | undefined): service is SouthboundCapableService {
  return typeof (service as { getSouthboundHoldings?: unknown } | undefined)?.getSouthboundHoldings === 'function'
}

/** 实现了主动买盘快照端点的行情服务（可选能力；连接器选择性实现）。 */
type ActiveBuyCapableService = MarketDataService & {
  getActiveBuySnapshot(symbol: string): Promise<ActiveBuySnapshot>
}

/** 能力探测（鸭子类型）：只认真正实现了可选方法的服务，缺席/非函数一律不算。 */
function hasActiveBuySnapshot(service: MarketDataService | undefined): service is ActiveBuyCapableService {
  return typeof (service as { getActiveBuySnapshot?: unknown } | undefined)?.getActiveBuySnapshot === 'function'
}

/**
 * 读取一个服务的 K 线能力声明（可选方法）。方法缺席、返回值非数组、条目形状不合格
 * 一律按「未声明」处理——缺席的语义是「没声明」，不是「不支持」，故这里不替连接器
 * 补默认值，也不把畸形声明当成拒绝。
 */
function klineCapabilitiesOf(service: MarketDataService | undefined): readonly KlineCapability[] {
  const declared = typeof service?.klineCapabilities === 'function' ? service.klineCapabilities() : undefined
  if (!Array.isArray(declared)) return []
  return declared.filter(cap =>
    typeof cap?.interval === 'string' && Number.isInteger(cap.maxBars) && cap.maxBars > 0)
}

/** 一次 K 线取数的候选：服务本体 + provider slug（老宿主路径问不到 slug 时缺席）。 */
interface KlineSourceCandidate {
  provider?: string
  service: MarketDataService
}

export interface DerivativesWire {
  ok: true
  derivatives: DerivativesData
}

export interface DerivativesHistoryWire {
  ok: true
  history: DerivativesHistory
}

export interface OrderbookWire {
  ok: true
  orderbook: Orderbook
}

export interface TradesWire {
  ok: true
  trades: TradeTick[]
}

/** 桥端逐笔上限（保护公共端点；GUI 流水只展示最近一段）。 */
export const MAX_TRADES_LIMIT = 100

/* -- 交易台 wire（issue #40）---------------------------------------------- */

export interface PositionsWire {
  ok: true
  positions: Position[]
}

export interface BalancesWire {
  ok: true
  balances: AccountBalance[]
}

export interface OpenOrdersWire {
  ok: true
  orders: Order[]
}

export interface TradeFillsWire {
  ok: true
  fills: TradeFill[]
}

export interface PlaceOrderWire {
  ok: true
  order: Order
}

/** GUI 下单体（只做真交易：默认 dryRun=false 实盘报单）。 */
export interface GuiOrderBody {
  readonly market?: unknown
  readonly symbol?: unknown
  readonly side?: unknown
  readonly type?: unknown
  readonly quantity?: unknown
  readonly price?: unknown
  readonly dryRun?: unknown
  /**
   * 发起动作的官方会话 id（审批绑定该会话的 agent）。缺省/未知 = 无审批上下文，
   * 实盘路径 fail-closed 到 TRADING_APPROVAL_DENIED（绝不静默降级为模拟）。
   */
  readonly sessionId?: unknown
  /**
   * 本次逻辑提交的稳定意图 id（客户端生成 UUID；未知结果/网络失败重试保持同一
   * 值，成功或主动新意图才换）。实盘必填：没有稳定意图的动作不允许下发。
   */
  readonly intentId?: unknown
}

export interface CustomIndicatorsWire {
  ok: true
  indicators: CustomIndicatorRecord[]
}

/** 图表激活名册 wire（issue #63）。 */
export interface ChartActivationsWire {
  ok: true
  instances: IndicatorInstance[]
}

/** 图表激活写入的业务拒绝（未知指标 id 等；协议错误仍走 BridgeProtocolError）。 */
export interface ChartActivationRejectedWire {
  ok: false
  code: 'TRADING_UNKNOWN_INDICATOR' | 'TRADING_INVALID_SCOPE'
  message: string
}

export interface KnowledgeCardsWire {
  ok: true
  cards: readonly KnowledgeCard[]
}

/* -- 统一资产台账 wire 与宿主面（issue #65，契约 §2/§3/§4）------------------ */

/** 台账快照（GET /holdings）。 */
export interface HoldingsWire {
  ok: true
  revision: number
  staged: Holding[]
  holdings: Holding[]
}

/** 写成功应答（stage/confirm/discard/add/update/remove）。 */
export interface HoldingsWriteWire {
  ok: true
  revision: number
  /** 仅 POST /holdings（手动新增）携带。 */
  id?: string
}

/** 校验失败（契约 §3：HTTP 200 + ok:false + TRADING_HOLDINGS_INVALID）。 */
export interface HoldingsRejectedWire {
  ok: false
  code: 'TRADING_HOLDINGS_INVALID'
  message: string
}

export interface HoldingsSnapshotShape {
  revision: number
  staged: Holding[]
  holdings: Holding[]
}

/**
 * 台账 store 的最小桥面（契约 §2 接口子集：snapshot/stage/confirm/discard/add/
 * update/remove）。宿主侧由 @dshtrading/holdings 的 file store 经 cordis 服务
 * `tradingHoldings`（Service 实例 .store 解包，knowledge 同款）注入；缺席时
 * createBridgeHost 回退 createFallbackHoldingsStore。
 *
 * 写操作返回值契约未刊（设计契约缺口，已回报）：本桥按「number = 新 revision」
 * 或「{ revision }」或「Holding（仅 add，取 id）」三种形状宽容解析，皆不可得
 * 时回退 snapshot().revision。
 */
export interface HoldingsStoreLike {
  snapshot(): HoldingsSnapshotShape | Promise<HoldingsSnapshotShape>
  stage(items: NewHoldingInput[]): unknown
  confirm(ids: string[], edits?: Record<string, Partial<NewHolding>>): unknown
  discard(ids: string[]): unknown
  add(item: NewHoldingInput): unknown
  update(id: string, patch: Partial<NewHolding>): unknown
  remove(id: string): unknown
}

/** FX 快照（/fx 应答有效载荷语义：rates[c] = 1 单位 c 折合多少 base）。 */
export interface FxRatesSnapshot {
  base: string
  rates: Record<string, number>
  asOf: number
  stale: boolean
}

/** FX 服务形状（@dshtrading/holdings/fx 集成时的适配目标，函数式最小面）。 */
export type FxRatesFetcher = (base: string) => Promise<FxRatesSnapshot>

/** FX 支持的基准币（契约 §4；USDT 恒定锚定 USD，不作基准）。 */
export const FX_BASES: readonly string[] = ['USD', 'CNY', 'HKD']

const HOLDING_CURRENCIES: readonly string[] = ['USD', 'CNY', 'HKD', 'USDT']
const HOLDING_KINDS: readonly string[] = ['real', 'sim']
/** 单次 stage 条数封顶（截图解析量级；防滥用，契约外附加护栏）。 */
export const MAX_HOLDINGS_STAGE_ITEMS = 100

function holdingsRejected(message: string): HoldingsRejectedWire {
  return { ok: false, code: 'TRADING_HOLDINGS_INVALID', message }
}

/**
 * 进程内内存台账兜底（knowledge 同款「缺席回退自建」语义——台账侧由
 * @dshtrading/holdings 专门导出的 createMemoryHoldingsStore 承载，其包注释
 * 明言「client-ui-trading 桥兜底/单测用」）：真实部署由同包 file store
 * （~/.dsh/holdings/book.json 原子写）经 tradingHoldings 服务注入；本兜底
 * 刻意不碰该文件（文件格式归 holdings 包所有，双写者会互相踩格式），重启即失。
 * §2 语义（id `hd-<ts>-<rand>`、revision 仅真实变更自增、默认值写入侧推导）
 * 由 store-core 单一实现保证。
 */
export function createFallbackHoldingsStore(): HoldingsStoreLike {
  return createMemoryHoldingsStore()
}

/**
 * 桥内 FX 兜底服务：直接复用 @dshtrading/holdings/fx 的 createFxService
 * （纯内存缓存，无文件层——文件缓存归 holdings 插件 ~/.dsh/holdings/
 * fx-cache.json 所有；集成时主 agent 经 tradingHoldings 服务 .fx 注入同一
 * 单实例替换本兜底）。语义契约 §4：frankfurter（ECB 汇率，免费无 key）→
 * 内存缓存 1h → 恒等兜底，后两段 stale:true；取倒数归一为「1 c 折合多少
 * base」；USDT 不入请求恒定锚 USD；fetch 超时 5s。base 白名单由 fx()
 * 路由先行校验（400），非法 base 不会到达本服务。
 */
export function createFallbackFxFetcher(fetchImpl?: FxFetchLike): FxRatesFetcher {
  const service = createFxService(fetchImpl !== undefined ? { fetchImpl } : {})
  return async (base: string): Promise<FxRatesSnapshot> => {
    const quote = await service.getRates(base)
    return { base: quote.base, rates: quote.rates, asOf: quote.asOf, stale: quote.stale }
  }
}

/** NewHoldingInput 字段校验（协议边界；失败 → TRADING_HOLDINGS_INVALID 业务错误）。
 *  account/kind/currency 可缺省（写入侧推导默认值），对齐包侧 NewHoldingInput 接受面。 */
export function parseNewHolding(body: unknown): NewHoldingInput | HoldingsRejectedWire {
  if (typeof body !== 'object' || body === null) return holdingsRejected('holding must be an object')
  const raw = body as Record<string, unknown>
  const market = typeof raw.market === 'string' ? raw.market.trim() : ''
  if (!isHoldingMarket(market)) return holdingsRejected(`holding.market must be one of ${HOLDING_MARKETS.join('/')}`)
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
  if (symbol === '') return holdingsRejected('holding.symbol is required')
  if (raw.side !== undefined && raw.side !== 'long') return holdingsRejected("holding.side only supports 'long'")
  const size = raw.size
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return holdingsRejected('holding.size must be a positive number')
  const patch = parseHoldingPatch(raw)
  if ('ok' in patch) return patch
  return {
    market,
    symbol,
    side: 'long',
    size,
    ...patch,
  }
}

/**
 * Partial<NewHolding> 校验（confirm edits / update patch 共用）：只摘契约字段，
 * 非法值整条拒绝。market/size/side 也可出现在 patch 里（确认对话框可编辑 market）。
 */
export function parseHoldingPatch(body: Record<string, unknown>): Partial<NewHolding> | HoldingsRejectedWire {
  const out: Partial<NewHolding> = {}
  if (body.market !== undefined) {
    const market = typeof body.market === 'string' ? body.market.trim() : ''
    if (!isHoldingMarket(market)) return holdingsRejected(`holding.market must be one of ${HOLDING_MARKETS.join('/')}`)
    out.market = market
  }
  if (body.symbol !== undefined) {
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
    if (symbol === '') return holdingsRejected('holding.symbol must be a non-empty string')
    out.symbol = symbol
  }
  if (body.side !== undefined) {
    if (body.side !== 'long') return holdingsRejected("holding.side only supports 'long'")
    out.side = 'long'
  }
  if (body.size !== undefined) {
    const size = body.size
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return holdingsRejected('holding.size must be a positive number')
    out.size = size
  }
  if (body.entryPrice !== undefined) {
    const entryPrice = body.entryPrice
    if (typeof entryPrice !== 'number' || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return holdingsRejected('holding.entryPrice must be a positive number')
    }
    out.entryPrice = entryPrice
  }
  if (body.currency !== undefined) {
    const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : ''
    if (!HOLDING_CURRENCIES.includes(currency)) {
      return holdingsRejected(`holding.currency must be one of ${HOLDING_CURRENCIES.join('/')}`)
    }
    out.currency = currency as HoldingCurrency
  }
  if (body.account !== undefined) {
    if (typeof body.account !== 'string' || body.account.trim() === '') {
      return holdingsRejected('holding.account must be a non-empty string')
    }
    out.account = body.account.trim()
  }
  if (body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !HOLDING_KINDS.includes(body.kind)) {
      return holdingsRejected("holding.kind must be 'real' or 'sim'")
    }
    out.kind = body.kind as Holding['kind']
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return holdingsRejected('holding.name must be a string')
    out.name = body.name
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') return holdingsRejected('holding.note must be a string')
    out.note = body.note
  }
  return out
}

/* -- 新闻 wire（issue #37）----------------------------------------------- */


/** 快讯流响应信封（桥 /flash；cursor 翻页 + 可选关键词搜索）。 */
export interface FlashWire {
  ok: true
  items: readonly NewsItem[]
  nextCursor?: string
  hasMore: boolean
}

export interface NewsWire {
  ok: true
  items: readonly NewsItem[]
  unavailable: readonly string[]
}

/** 宏观日历响应信封（桥 /macro/calendar；2026-09-15 金十接入）。 */
export interface MacroCalendarWire {
  ok: true
  items: readonly MacroCalendarEntry[]
}

/** 央行利率响应信封（桥 /macro/rates）。 */
export interface MacroRatesWire {
  ok: true
  items: readonly MacroRateEntry[]
}

/**
 * 预测市场响应信封（桥 /prediction/*；2026-10-11 Polymarket 接入）。
 *
 * `fetchedAt` 是**取数时刻**（连接器侧记录），与会议数据同源返回——面板据此显示
 * 「数据时间」，不猜客户端收到响应的时刻。
 */
export interface PredictionWire {
  ok: true
  fetchedAt: string
  meetings: readonly PredictionMeeting[]
}

/** 新闻端点条目上限（保护公共数据源；超出部分由 Kit 层截流）。 */
export const MAX_NEWS_LIMIT = 50

/** 宏观日历条目上限（上游一页即整周；与 connector MACRO_CALENDAR_MAX 对齐。整周实测已到 254 条，250 会裁掉周尾）。 */
export const MAX_MACRO_CALENDAR_LIMIT = 400

export class BridgeProtocolError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function isMarketId(value: string): value is MarketId {
  return (MARKET_IDS as readonly string[]).includes(value)
}

/** 台账市场守卫（holdings 契约面 4 市场）：futures 属数据面，无台账/账户，不得写入。 */
function isHoldingMarket(value: string): value is HoldingMarket {
  return (HOLDING_MARKETS as readonly string[]).includes(value)
}

/** 动态标的全集缓存 TTL（30分钟）。 */
export const SYMBOLS_CACHE_TTL_MS = 30 * 60 * 1000

/**
 * 动态标的全集缓存条目上限：键 = market，键空间 = 市场全集（当前 6），取全集长度
 * 即与改动前的裸 Map「永不驱逐」等价——上限只是 TtlCache 的必要参数，不是驱逐策略。
 */
export const SYMBOLS_CACHE_MAX = MARKET_IDS.length

/**
 * 基本面数据包缓存 TTL（5分钟）：财报级/日级数据，非 tick；同键 in-flight 去重
 * 让 tab 翻转与快速切标的只打一轮上游（issue #36 整改，2026-09-02）。
 */
export const FUNDAMENTALS_CACHE_TTL_MS = 5 * 60 * 1000

/** 基本面缓存条目上限（LRU）：财报级数据包体积大，长生命周期宿主必须有界。 */
export const FUNDAMENTALS_CACHE_MAX = 64

/**
 * 港股通持股历史缓存 TTL（5分钟）：日频序列（每交易日一个点），非 tick；
 * 与 fundamentals 同款「TTL + 同键 in-flight 去重」，副图随级别切换反复取数
 * 时一次翻转只打一轮上游（2026-10-13 港股通持股副图，契约 C §4）。
 */
export const SOUTHBOUND_CACHE_TTL_MS = 5 * 60 * 1000

/** 港股通持股缓存条目上限（LRU）：按「市场:标的」为键，宿主长生命周期必须有界。 */
export const SOUTHBOUND_CACHE_MAX = 64

/** 读一个「必须是字符串」的可选字段：非字符串/空白一律回空串（形状不信任）。 */
function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 从 Error 上提取结构化错误词汇（连接器按 TradingError 形状附加 code）。 */
export function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const raw = (error as { code?: unknown }).code
    const code = typeof raw === 'string' ? raw : 'TRADING_UNKNOWN'
    return { code, message: error.message }
  }
  return { code: 'TRADING_UNKNOWN', message: String(error) }
}

/**
 * K 线取数里「运行时故障类」的错误码集合（2026-10-23 口径）：这些码说的是「当前源此刻答不出」，
 * 不是「这个源结构性没有这份数据」。
 *   - `TRADING_NETWORK`：网络级失败（单枪超时、按主机熔断打开、连接已建立之后的 HTTP 空回）；
 *   - `TRADING_UPSTREAM_ERROR`：HTTP 非 2xx。
 * 不在集合内的一律原样抛：`TRADING_RATE_LIMITED`（429 是上游明确的「别打」信号，换源等于把
 * 压力摊给别家）、`TRADING_EXCHANGE_ERROR`（业务错误/坏符号语义）、`TRADING_SYMBOL_NOT_FOUND`、
 * `TRADING_UNSUPPORTED_SYMBOL`——换个源答出来的数字不是同一个事实。
 */
const KLINE_RUNTIME_FAILURE_CODES: ReadonlySet<string> = new Set(['TRADING_NETWORK', 'TRADING_UPSTREAM_ERROR'])

/**
 * 运行时故障换源的硬上界：一次取数最多兜底 1 次（即最多打 2 个源）。
 *
 * 有界是这条兜底的准入条件。东财 2026-10-23 二次实测：网络级失败是「连接已建立之后的 HTTP
 * 空回」，最长连败 6 枪跨 22.7 秒；connector-eastmoney 自身已有 3 枪 / 固定 200ms 冷却 /
 * 3s 整通硬截止 / 按主机 30s 熔断。桥若按候选数串联，上游压力会被放大成「N 个源 × 各自的枪数」，
 * 延迟与语义都不可控。结构性缺能力（`TRADING_UNSUPPORTED_INTERVAL`）不吃这个上界。
 */
const KLINE_RUNTIME_FALLBACK_LIMIT = 1

export class TradingBridge {
  private readonly symbolsCache = new TtlCache<SymbolInfoWire[]>(SYMBOLS_CACHE_TTL_MS, SYMBOLS_CACHE_MAX)
  private readonly fundamentalsCache = new TtlCache<StockFundamentals>(FUNDAMENTALS_CACHE_TTL_MS, FUNDAMENTALS_CACHE_MAX)
  private readonly fundamentalsInflight = new Map<string, Promise<StockFundamentals>>()
  /** 港股通持股历史缓存（2026-10-13；键 = `${market}:${symbol}`，同 fundamentals 模式）。 */
  private readonly southboundCache = new TtlCache<SouthboundHoldingHistory>(SOUTHBOUND_CACHE_TTL_MS, SOUTHBOUND_CACHE_MAX)
  private readonly southboundInflight = new Map<string, Promise<SouthboundHoldingHistory>>()
  /** FX 兜底 fetcher（issue #65；host.fetchFxRates 注入正式实现时不走这里）。 */
  readonly #fallbackFxFetcher: FxRatesFetcher = createFallbackFxFetcher()

  constructor(private readonly host: BridgeHost) {}

  /**
   * 已安装（有行情服务）的市场清单 + 当前 provider slug + 该市场声明的 K 线能力并集。
   * 能力并集取自**全部注册项**（不是 active 一项）：它回答的是「这个市场能不能取到某
   * (周期, 深度)」，与当前路由无关——跨源解析会兜住路由缺的那部分（见 klines）。
   */
  markets(): MarketsWire {
    const markets: MarketInfoWire[] = []
    for (const id of MARKET_IDS) {
      if (this.host.getMarketService(id) === undefined) continue
      const provider = this.host.activeProvider(id)
      const klineCapabilities = this.#marketKlineCapabilities(id)
      markets.push({
        id,
        ...(provider === undefined ? {} : { provider }),
        ...(klineCapabilities.length === 0 ? {} : { klineCapabilities }),
      })
    }
    return { markets }
  }

  /**
   * 该市场全部注册项声明的能力并集：同 interval 取 maxBars 最大值。
   * 顺序 = 注册项遍历顺序下的「interval 首次出现序」，不按词汇表重排——api 词汇表新增
   * 周期时，这里不该因为不认识它而把该周期从并集里丢掉。注册表缺席（老宿主）→ 空并集。
   */
  #marketKlineCapabilities(market: MarketId): KlineCapabilityWire[] {
    const union = new Map<string, number>()
    for (const entry of this.host.marketRegistry?.list?.(market) ?? []) {
      for (const cap of klineCapabilitiesOf(entry.service)) {
        union.set(cap.interval, Math.max(union.get(cap.interval) ?? 0, cap.maxBars))
      }
    }
    return [...union].map(([interval, maxBars]) => ({ interval, maxBars }))
  }

  /**
   * 批量报价：逐 symbol 独立成功/失败（一个坏代码不拖垮整批）。
   * provider 显式指定取数源时必须命中该市场**已注册项**；未命中或注册表缺席 → 400
   * （不静默降级到 active——用户显式指定的源是权威）。未给 provider 时维持现行 active
   * 解析与批量语义（MAX_SYMBOLS 闸门、逐符号信封都不变）。
   */
  async tickers(market: string, symbols: string[], provider?: string): Promise<TickersWire> {
    const id = this.#requireMarketId(market)
    const unique = [...new Set(symbols.map(symbol => symbol.trim()).filter(Boolean))]
    if (unique.length === 0) throw new BridgeProtocolError(400, 'tickers: symbols is required')
    if (unique.length > MAX_SYMBOLS) {
      throw new BridgeProtocolError(400, `tickers: too many symbols (${unique.length} > ${MAX_SYMBOLS})`)
    }
    const service = provider === undefined ? this.#requireMarketService(id) : this.#requireMarketServiceFor(id, provider)
    return { tickers: await this.fetchTickerOutcomes(service, unique) }
  }

  /** 市场 id 守卫（行情侧共用前奏第一步）：非法 → 400 `unknown market "X"`，并窄化出 MarketId。 */
  #requireMarketId(market: string): MarketId {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    return market
  }

  /**
   * 行情服务解析（行情侧共用前奏）：active 解析；市场未安装 → 400 `market X is not installed`。
   * 调用点已过 #requireMarketId 时内部重复校验是幂等的（helper 自身保持完备，可独立调用）。
   */
  #requireMarketService(market: string): MarketDataService {
    const id = this.#requireMarketId(market)
    const service = this.host.getMarketService(id)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    return service
  }

  /**
   * 显式 provider 的行情服务解析：必须命中该市场**已注册项**，否则 400（绝不静默降级到
   * active——用户显式指定的源是权威）。文案沿用 #requireRegisteredService。
   */
  #requireMarketServiceFor(market: string, provider: string): MarketDataService {
    return this.#requireRegisteredService(this.#requireMarketId(market), provider)
  }

  /** 按 provider slug 解析同市场已注册行情服务；未注册/注册表缺席 → 400（绝不静默换源）。 */
  #requireRegisteredService(market: MarketId, provider: string): MarketDataService {
    const entry = this.host.marketRegistry?.list?.(market)?.find(item => item.provider === provider)
    if (entry === undefined) {
      throw new BridgeProtocolError(400, `tickers: provider ${JSON.stringify(provider)} is not a registered source of market ${market}`)
    }
    return entry.service
  }

  /** 单只取数：成败各自成信封，错误码取自连接器抛出的 TradingError。 */
  private async fetchTickerOutcome(service: MarketDataService, symbol: string): Promise<TickerOutcome> {
    try {
      return { ok: true, ticker: await service.getTicker(symbol) }
    } catch (error) {
      return { ok: false, ...errorPayload(error) }
    }
  }

  /**
   * 批量报价取数（2026-10-14 批量端点）：连接器实现 `getTickers` 时一次调用取全批，
   * 只有确实拿到行的符号走批量，缺行回落逐只 `getTicker`（保住各符号自己的错误码，
   * 如 TRADING_UNSUPPORTED_SYMBOL / TRADING_SYMBOL_NOT_FOUND）；整批抛错时全批
   * 记同一份错误信封且不再逐只重试（故障期不得把上游压力放大 N 倍）。
   * 未实现 `getTickers` 的连接器（绝大多数）逐只路径不变；返回顺序 = 入参顺序。
   */
  private async fetchTickerOutcomes(service: MarketDataService, symbols: string[]): Promise<Record<string, TickerOutcome>> {
    const tickers: Record<string, TickerOutcome> = {}
    if (typeof service.getTickers !== 'function') {
      const outcomes = await Promise.all(symbols.map(async (symbol): Promise<TickerOutcome> => this.fetchTickerOutcome(service, symbol)))
      symbols.forEach((symbol, index) => { tickers[symbol] = outcomes[index] as TickerOutcome })
      return tickers
    }
    let batch: Record<string, Ticker> | undefined
    try {
      batch = await service.getTickers(symbols)
    } catch (error) {
      const envelope = errorPayload(error)
      for (const symbol of symbols) tickers[symbol] = { ok: false, ...envelope }
      return tickers
    }
    const missing = symbols.filter(symbol => !isBatchTicker(batch?.[symbol]))
    const fallback = new Map<string, TickerOutcome>()
    if (missing.length > 0) {
      const outcomes = await Promise.all(missing.map(async (symbol): Promise<TickerOutcome> => this.fetchTickerOutcome(service, symbol)))
      missing.forEach((symbol, index) => { fallback.set(symbol, outcomes[index] as TickerOutcome) })
    }
    for (const symbol of symbols) {
      const ticker = batch?.[symbol]
      // 缺行/坏行符号必已在 fallback 里补过；只有非空对象才直接采用（不做任何修补/造假）。
      tickers[symbol] = isBatchTicker(ticker) ? { ok: true, ticker } : fallback.get(symbol) as TickerOutcome
    }
    return tickers
  }

  /**
   * K 线：按能力跨源解析取数源（2026-10-15 契约 + 2026-10-23 窄修不变量 #9，
   * 规则见 #resolveKlinesSources）。
   *
   * 参数闸门不变（interval 照旧透传、limit 限 1..MAX_KLINE_LIMIT、不截断返回）；
   * 变化只在「谁来供数」与 wire 上的 provider 标注：
   *   - 结构性缺能力：选中源抛 TRADING_UNSUPPORTED_INTERVAL（本源没有这份数据）→ 沿候选序
   *     试下一个未试过的候选，不论它是否声明（声明只是预判，错误码才是事实）；这条路一直走到
   *     候选序尽头，不受下面那条上界约束；
   *   - 运行时故障：TRADING_NETWORK / TRADING_UPSTREAM_ERROR → 也可兜底，但**全程最多 1 次**
   *     （一次取数最多打 2 个源，见 KLINE_RUNTIME_FALLBACK_LIMIT），不做长链串联；
   *   - 其余错误码（限流/坏符号/交易所业务错误）**一律原样抛、绝不换源**：它们说的是「这次
   *     请求本身不成立」，换个源答出来的数字不是同一个事实；
   *   - 整段同源：返回的序列整体来自最终成功的那一个源，不拼接前一个源的部分结果；
   *   - provider 如实标注最终供数的 slug（问不到时省略该字段），wire 不新增字段；
   *   - 候选耗尽 → 原样抛最后一个错误（绝不返回空序列冒充「无数据」）。
   */
  async klines(market: string, symbol: string, interval: string, rawLimit: string | null): Promise<KlinesWire> {
    const id = this.#requireMarketId(market)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'klines: symbol is required')
    const limit = rawLimit === null || rawLimit === undefined ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_KLINE_LIMIT)) {
      throw new BridgeProtocolError(400, `klines: limit must be an integer in 1..${MAX_KLINE_LIMIT}`)
    }
    const candidates = this.#resolveKlinesSources(id, interval as Interval, limit)
    if (candidates.length === 0) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    let lastError: unknown = undefined
    // 结构性缺能力与运行时故障各算各的：前者不设上界（既有语义），后者硬上界 1 次。
    // 两个计数/判断分开写，不用 candidates.slice(0, 2) 那种一刀切——那会把结构路径也削短。
    let runtimeFallbacks = 0
    for (const candidate of candidates) {
      try {
        const klines = await candidate.service.getKlines(trimmed, interval as Interval, limit)
        return candidate.provider === undefined ? { klines } : { klines, provider: candidate.provider }
      } catch (error) {
        lastError = error
        const code = errorPayload(error).code
        if (code === 'TRADING_UNSUPPORTED_INTERVAL') continue
        if (!KLINE_RUNTIME_FAILURE_CODES.has(code) || runtimeFallbacks >= KLINE_RUNTIME_FALLBACK_LIMIT) throw error
        runtimeFallbacks += 1
      }
    }
    throw lastError
  }

  /**
   * K 线候选序（冻结）：active 在最前，其后 registry.list(market) 的**其余项**按 provider 名
   * 升序（与 #resolveSouthboundService 同口径）。active 缺席（路由指向未注册的 provider 或市场
   * 未安装）→ 空候选，调用方照旧 400「is not installed」：用户设置是权威，不为它换源。
   * 注册表/list 缺席（老宿主）→ 只有 active 一项，行为与改动前一致。
   */
  #klineCandidates(market: MarketId): KlineSourceCandidate[] {
    const registry = this.host.marketRegistry
    const registered = registry?.active?.(market)
    const activeService = registered?.service ?? this.host.getMarketService(market)
    if (activeService === undefined) return []
    const candidates: KlineSourceCandidate[] = [
      registered === undefined ? { service: activeService } : { provider: registered.provider, service: activeService },
    ]
    const rest = [...(registry?.list?.(market) ?? [])]
      .filter(entry => entry.service !== activeService)
      .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
    for (const entry of rest) candidates.push({ provider: entry.provider, service: entry.service })
    return candidates
  }

  /**
   * K 线取数解析：返回「先本次选择、后其余候选」的候选序——兜底只需顺序走完它，
   * 就等价于「沿候选序继续试下一个未试过的候选」。
   *
   * 选择规则（确定性，不看质量/速度）：
   *   (a) active 的声明覆盖请求（有该 interval，且 limit 缺省或 maxBars >= limit）→ active；
   *   (b) 否则取候选序里第一个声明覆盖的候选；
   *   (c) 无任何声明覆盖 → active（未声明路径，结构性不足交给错误码兜底）。
   * 不变量：active 有能力就**先**用 active——跨源的触发只有两种，结构性缺能力
   * （TRADING_UNSUPPORTED_INTERVAL，走到候选序尽头）与运行时故障（TRADING_NETWORK /
   * TRADING_UPSTREAM_ERROR，全程最多兜底 1 次），见 klines。
   */
  #resolveKlinesSources(market: MarketId, interval: Interval, limit: number | undefined): KlineSourceCandidate[] {
    const candidates = this.#klineCandidates(market)
    if (candidates.length <= 1) return candidates
    const covers = (candidate: KlineSourceCandidate): boolean =>
      klineCapabilitiesOf(candidate.service).some(cap =>
        cap.interval === interval && (limit === undefined || cap.maxBars >= limit))
    const active = candidates[0] as KlineSourceCandidate
    if (covers(active)) return candidates
    const chosen = candidates.find((candidate, index) => index > 0 && covers(candidate))
    if (chosen === undefined) return candidates
    return [chosen, ...candidates.filter(candidate => candidate !== chosen)]
  }

  /** 动态标的全集（带 30min 进程内缓存；未实现或异常静默回落空列表）。 */
  async symbols(market: string, query?: string): Promise<SymbolsWire> {
    const service = this.#requireMarketService(market)
    if (typeof service.listInstruments !== 'function') {
      return { symbols: [] }
    }
    const trimmed = query?.trim().toLowerCase()
    if (trimmed) {
      try {
        const list = await (service as unknown as { listInstruments(q?: string): Promise<InstrumentRef[]> }).listInstruments(trimmed)
        let symbols: SymbolInfoWire[] = Array.isArray(list) ? list.map(toSymbolInfoWire) : []
        // 防御性兜底：若连接器实现未做服务端过滤（忽略 query 返回全量），本地执行严格匹配
        const isServerFiltered = symbols.length === 0 || symbols.every(s =>
          s.symbol.toLowerCase().includes(trimmed) || (s.name !== undefined && s.name.toLowerCase().includes(trimmed))
        )
        if (!isServerFiltered) {
          symbols = symbols.filter(s =>
            s.symbol.toLowerCase().includes(trimmed) || (s.name !== undefined && s.name.toLowerCase().includes(trimmed))
          )
        }
        return { symbols }
      } catch {
        return { symbols: [] }
      }
    }
    const cached = this.symbolsCache.getFresh(market, Date.now())
    if (cached !== undefined) {
      return { symbols: cached }
    }
    try {
      const list = await service.listInstruments()
      const symbols: SymbolInfoWire[] = Array.isArray(list) ? list.map(toSymbolInfoWire) : []
      this.symbolsCache.set(market, symbols, Date.now())
      return { symbols }
    } catch {
      return { symbols: [] }
    }
  }

  /**
   * 衍生品指标快照（GUI「衍生品」面板，issue #38）：单 symbol 透传注册表解析出的
   * 行情服务。连接器未实现可选 getDerivatives（现货/股票数据源）→ 业务错误
   * TRADING_NOT_IMPLEMENTED（HTTP 200 + ok:false），前端直接隐藏面板（不降级）。
   */
  async derivatives(market: string, symbol: string): Promise<DerivativesWire> {
    const id = this.#requireMarketId(market)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'derivatives: symbol is required')
    const service = this.#requireMarketService(id)
    if (typeof service.getDerivatives !== 'function') {
      throw Object.assign(
        new Error(`market ${market} provider does not implement derivatives — spot market`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return { ok: true, derivatives: await service.getDerivatives(trimmed) }
  }

  /**
   * 衍生品历史序列（GUI「衍生品」页签趋势卡，issue #54）：单 symbol 透传。
   * 连接器未实现可选 getDerivativesHistory → TRADING_NOT_IMPLEMENTED 业务错误
   * （HTTP 200 + ok:false），前端隐藏趋势卡、保留快照读数（与快照同纪律）。
   */
  async derivativesHistory(market: string, symbol: string): Promise<DerivativesHistoryWire> {
    const id = this.#requireMarketId(market)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'derivatives history: symbol is required')
    const service = this.#requireMarketService(id)
    if (typeof service.getDerivativesHistory !== 'function') {
      throw Object.assign(
        new Error(`market ${market} provider does not implement derivatives history`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return { ok: true, history: await service.getDerivativesHistory(trimmed) }
  }

  /**
   * 盘口快照（GUI「盘口」竖栏，issue #39）：单 symbol 透传。连接器未实现可选
   * getOrderbook（yahoo/stooq/腾讯 r_hk）→ TRADING_NOT_IMPLEMENTED 业务错误，
   * 前端竖栏显示「该市场未提供盘口」。
   */
  async orderbook(market: string, symbol: string): Promise<OrderbookWire> {
    const id = this.#requireMarketId(market)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'orderbook: symbol is required')
    const service = this.#requireMarketService(id)
    if (typeof service.getOrderbook !== 'function') {
      throw Object.assign(
        new Error(`market ${market} provider does not implement orderbook`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return { ok: true, orderbook: await service.getOrderbook(trimmed) }
  }

  /**
   * 最近逐笔成交（GUI「分笔」流水，issue #39）：透传 limit（服务端封顶）。
   * 未实现可选 getRecentTrades（腾讯沪深行情行无逐笔端点）→ TRADING_NOT_IMPLEMENTED。
   */
  async trades(market: string, symbol: string, rawLimit: string | null): Promise<TradesWire> {
    const id = this.#requireMarketId(market)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'trades: symbol is required')
    const limit = rawLimit === null || rawLimit === undefined ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_TRADES_LIMIT)) {
      throw new BridgeProtocolError(400, `trades: limit must be an integer in 1..${MAX_TRADES_LIMIT}`)
    }
    const service = this.#requireMarketService(id)
    if (typeof service.getRecentTrades !== 'function') {
      throw Object.assign(
        new Error(`market ${market} provider does not implement recent trades`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return { ok: true, trades: await service.getRecentTrades(trimmed, limit) }
  }

  /* ---------------------------------------------------------------- */
  /* 交易台（issue #40）：只读查询 + 强制 dry-run 下单                      */
  /* ---------------------------------------------------------------- */

  /** 交易服务解析：注册表无注册项（未安装交易连接器）→ undefined（调用方 400）。 */
  #requireTradeService(market: string): TradeService {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trade = this.host.getTradeService?.(market)
    if (trade === undefined) {
      // 专用 code（2026-09-04）：前端据此区分「市场未挂交易连接器」与「凭证缺失」，
      // 不再把服务未注册误导渲染成「凭证未配置或不可用」。
      throw Object.assign(new BridgeProtocolError(400, `no trade service for market ${market}`), { code: 'TRADING_NO_TRADE_SERVICE' })
    }
    return trade
  }

  async positions(market: string): Promise<PositionsWire> {
    return { ok: true, positions: await this.#requireTradeService(market).getPositions() }
  }

  async balances(market: string): Promise<BalancesWire> {
    const trade = this.#requireTradeService(market)
    if (typeof trade.getBalances !== 'function') {
      throw Object.assign(new Error('trade service does not implement balances'), { code: 'TRADING_NOT_IMPLEMENTED' })
    }
    return { ok: true, balances: await trade.getBalances() }
  }

  async openOrders(market: string): Promise<OpenOrdersWire> {
    const trade = this.#requireTradeService(market)
    if (typeof trade.listOpenOrders !== 'function') {
      throw Object.assign(new Error('trade service does not implement open orders'), { code: 'TRADING_NOT_IMPLEMENTED' })
    }
    return { ok: true, orders: await trade.listOpenOrders() }
  }

  async tradeFills(market: string): Promise<TradeFillsWire> {
    const trade = this.#requireTradeService(market)
    if (typeof trade.listTradeFills !== 'function') {
      throw Object.assign(new Error('trade service does not implement trade fills'), { code: 'TRADING_NOT_IMPLEMENTED' })
    }
    return { ok: true, fills: await trade.listTradeFills() }
  }

  /**
   * GUI 实盘动作的逐动作审批闸门（唯一出口，2026-10-12）：
   * 审批座位缺席 / 无会话上下文 / 会话串号 / 用户拒绝 / 取消 / 连接断开，一律抛
   * `TRADING_APPROVAL_DENIED`，绝不静默降级成模拟单或伪造回执。
   * @param action - 规范化动作（展示 + 绑定同源）。
   * @param signal - HTTP 连接信号（断连/超时即取消审批）。
   */
  async #authorizeGuiLiveAction(action: GuiLiveAction, signal?: AbortSignal): Promise<void> {
    const seat = this.host.guiApproval
    if (seat === undefined) {
      throw new GuiApprovalDeniedError('the GUI approval seat is not mounted on this bridge host')
    }
    await seat.authorize(action, { signal })
  }

  /**
   * GUI 下单（真交易执行）：支持实盘报单（默认 dryRun: false）。
   * 实盘路径先过逐动作审批（{@link TradingBridge.#authorizeGuiLiveAction}）；审批没成
   * 就没有订单。若底层连接器未配置 API 凭证或未获人工签署实盘授权，由服务缝闸门抛出
   * 标准错误，桥层如实向前端返回，杜绝伪造假成交。
   */
  async placeOrderFromGui(market: string, body: GuiOrderBody, signal?: AbortSignal): Promise<PlaceOrderWire> {
    const trade = this.#requireTradeService(market)
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
    const side = body.side === 'sell' ? 'sell' as const : body.side === 'buy' ? 'buy' as const : undefined
    const type = body.type === 'limit' ? 'limit' as const : body.type === 'market' ? 'market' as const : undefined
    const quantity = typeof body.quantity === 'number' ? body.quantity : Number.NaN
    if (symbol === '') throw new BridgeProtocolError(400, 'place order: symbol is required')
    if (side === undefined) throw new BridgeProtocolError(400, 'place order: side must be buy or sell')
    if (type === undefined) throw new BridgeProtocolError(400, 'place order: type must be market or limit')
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BridgeProtocolError(400, 'place order: quantity must be a positive number')
    }
    const price = typeof body.price === 'number' ? body.price : undefined
    if (type === 'limit' && (price === undefined || !Number.isFinite(price) || price <= 0)) {
      throw new BridgeProtocolError(400, 'place order: limit orders require a positive price')
    }
    const requestedDryRun = typeof body.dryRun === 'boolean' ? body.dryRun : false
    const intentId = readTrimmedString(body.intentId)
    const sessionId = readTrimmedString(body.sessionId)
    if (requestedDryRun !== true) {
      // 所有实盘调用必须有稳定意图：没有意图 id 就没有可审计、可去重的动作身份。
      if (intentId === '') {
        throw new BridgeProtocolError(400, 'place order: live orders require an intentId')
      }
      await this.#authorizeGuiLiveAction({
        action: 'place-order',
        market,
        symbol,
        side,
        type,
        quantity,
        ...(price !== undefined ? { price } : {}),
        intentId,
        sessionId,
      }, signal)
    }
    // intentId 由 @dshtrading/api 的 OrderRequest 收录（并行流：可选 intentId）；合入前
    // 用交叉类型承载，条件 spread 透传——连接器据此把同一意图的重试收敛成同一笔。
    const request: OrderRequest & { readonly intentId?: string } = {
      symbol,
      side,
      type,
      quantity,
      ...(price !== undefined ? { price } : {}),
      dryRun: requestedDryRun,
      ...(intentId === '' ? {} : { intentId }),
    }
    const order = await trade.placeOrder(request)
    return { ok: true, order }
  }

  /**
   * GUI 撤单（issue #40）：按 market + orderId + 可选 symbol 分发到激活的交易服务。
   * 撤单与下单同门槛（2026-10-12）：先过逐动作审批，审批没成订单照旧挂着。
   * @param context.sessionId - 发起动作的官方会话 id（审批绑定）。
   * @param context.intentId - 本次撤单的稳定意图 id（实盘必填）。
   * @param context.signal - HTTP 连接信号。
   */
  async cancelOrderFromGui(
    market: string,
    orderId: string,
    symbol?: string,
    context?: { readonly sessionId?: string | undefined; readonly intentId?: string | undefined; readonly signal?: AbortSignal | undefined },
  ): Promise<{ ok: true; canceled: boolean }> {
    const trade = this.#requireTradeService(market)
    const trimmedId = orderId.trim()
    if (!trimmedId) throw new BridgeProtocolError(400, 'cancel order: id is required')
    const trimmedSymbol = symbol?.trim()
    const intentId = context?.intentId?.trim() ?? ''
    if (intentId === '') {
      throw new BridgeProtocolError(400, 'cancel order: live cancellations require an intentId')
    }
    await this.#authorizeGuiLiveAction({
      action: 'cancel-order',
      market,
      orderId: trimmedId,
      ...(trimmedSymbol === undefined || trimmedSymbol === '' ? {} : { symbol: trimmedSymbol }),
      intentId,
      sessionId: context?.sessionId?.trim() ?? '',
    }, context?.signal)
    await trade.cancelOrder(trimmedId, trimmedSymbol)
    return { ok: true, canceled: true }
  }

  /** 自定义指标列表。 */
  async customIndicators(): Promise<CustomIndicatorsWire> {
    const store = this.host.customIndicatorsStore
    if (store === undefined) return { ok: true, indicators: [] }
    const indicators = await store.list()
    return { ok: true, indicators }
  }

  /** 删除自定义指标。 */
  async deleteCustomIndicator(id: string): Promise<{ ok: boolean; removed: boolean }> {
    const store = this.host.customIndicatorsStore
    if (store === undefined) return { ok: true, removed: false }
    const removed = await store.remove(id)
    return { ok: true, removed }
  }

  /** 获取全部沉淀的知识卡片列表。 */
  async knowledgeCards(): Promise<KnowledgeCardsWire> {
    const store = this.host.knowledgeStore
    if (store === undefined) return { ok: true, cards: [] }
    const cards = await store.list()
    return { ok: true, cards }
  }

  /* -- 统一资产台账（issue #65，契约 §3）------------------------------------ */

  /** 台账快照（staged 待确认区 + holdings 正式区 + revision）。 */
  async holdings(): Promise<HoldingsWire> {
    const store = this.host.holdingsStore
    if (store === undefined) return { ok: true, revision: 0, staged: [], holdings: [] }
    const snap = await store.snapshot()
    return { ok: true, revision: snap.revision, staged: [...snap.staged], holdings: [...snap.holdings] }
  }

  /**
   * 写操作 revision 宽容解析（契约未刊 store 返回形状，已回报）：
   * number / { revision } / 其它 → 回退 snapshot().revision。
   */
  async #holdingsRevision(result: unknown): Promise<number> {
    if (typeof result === 'number' && Number.isFinite(result)) return result
    if (typeof result === 'object' && result !== null) {
      const revision = (result as { revision?: unknown }).revision
      if (typeof revision === 'number' && Number.isFinite(revision)) return revision
    }
    const snap = await this.host.holdingsStore?.snapshot()
    return snap?.revision ?? 0
  }

  #requireHoldingsStore(): HoldingsStoreLike {
    const store = this.host.holdingsStore
    if (store === undefined) {
      throw Object.assign(new Error('holdings store is not mounted'), { code: 'TRADING_HOLDINGS_UNAVAILABLE' })
    }
    return store
  }

  /** staged 待确认区入库（Agent 截图解析唯一写入口）。 */
  async stageHoldings(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    const items = typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items)
      ? (body as { items: unknown[] }).items
      : undefined
    if (items === undefined) return holdingsRejected('stage: body.items must be an array')
    if (items.length === 0) return holdingsRejected('stage: items is empty')
    if (items.length > MAX_HOLDINGS_STAGE_ITEMS) {
      return holdingsRejected(`stage: too many items (${items.length} > ${MAX_HOLDINGS_STAGE_ITEMS})`)
    }
    const parsed: NewHoldingInput[] = []
    for (const item of items) {
      const result = parseNewHolding(item)
      if ('ok' in result) return result
      parsed.push(result)
    }
    const store = this.#requireHoldingsStore()
    const result = await store.stage(parsed)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** 确认 staged 入账（可带逐条编辑）。 */
  async confirmHoldings(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    if (typeof body !== 'object' || body === null) return holdingsRejected('confirm: body must be an object')
    const raw = body as { ids?: unknown; edits?: unknown }
    const ids = Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === 'string' && id !== '') : []
    if (ids.length === 0) return holdingsRejected('confirm: ids must be a non-empty string array')
    let edits: Record<string, Partial<NewHolding>> | undefined
    if (raw.edits !== undefined) {
      if (typeof raw.edits !== 'object' || raw.edits === null) return holdingsRejected('confirm: edits must be an object')
      edits = {}
      for (const [id, patchBody] of Object.entries(raw.edits as Record<string, unknown>)) {
        if (typeof patchBody !== 'object' || patchBody === null) return holdingsRejected(`confirm: edits[${id}] must be an object`)
        const patch = parseHoldingPatch(patchBody as Record<string, unknown>)
        if ('ok' in patch) return patch
        edits[id] = patch
      }
    }
    const store = this.#requireHoldingsStore()
    const result = edits === undefined ? await store.confirm(ids) : await store.confirm(ids, edits)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** 丢弃 staged 条目。 */
  async discardHoldings(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    if (typeof body !== 'object' || body === null) return holdingsRejected('discard: body must be an object')
    const ids = Array.isArray((body as { ids?: unknown }).ids)
      ? (body as { ids: unknown[] }).ids.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
    if (ids.length === 0) return holdingsRejected('discard: ids must be a non-empty string array')
    const store = this.#requireHoldingsStore()
    const result = await store.discard(ids)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** 手动新增一条导入持仓（直入正式区）。 */
  async addHolding(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    const parsed = parseNewHolding(body)
    if ('ok' in parsed) return parsed
    const store = this.#requireHoldingsStore()
    const result = await store.add(parsed)
    // add 返回形状契约未刊：对象带 id 则取之；否则回退快照末位（本地单写者语义）。
    let id = typeof result === 'object' && result !== null ? (result as { id?: unknown }).id : undefined
    if (typeof id !== 'string' || id === '') {
      const snap = await store.snapshot()
      id = snap.holdings[snap.holdings.length - 1]?.id
    }
    if (typeof id !== 'string' || id === '') {
      throw Object.assign(new Error('holdings store add() did not yield an id'), { code: 'TRADING_UNKNOWN' })
    }
    return { ok: true, revision: await this.#holdingsRevision(result), id }
  }

  /** 编辑一条导入持仓。 */
  async updateHolding(body: unknown): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    if (typeof body !== 'object' || body === null) return holdingsRejected('update: body must be an object')
    const raw = body as { id?: unknown; patch?: unknown }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') return holdingsRejected('update: id is required')
    if (typeof raw.patch !== 'object' || raw.patch === null) return holdingsRejected('update: patch must be an object')
    const patch = parseHoldingPatch(raw.patch as Record<string, unknown>)
    if ('ok' in patch) return patch
    const store = this.#requireHoldingsStore()
    const result = await store.update(id, patch)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** 删除一条导入持仓。 */
  async removeHolding(id: string): Promise<HoldingsWriteWire | HoldingsRejectedWire> {
    const trimmed = id.trim()
    if (trimmed === '') return holdingsRejected('remove: id is required')
    const store = this.#requireHoldingsStore()
    const result = await store.remove(trimmed)
    return { ok: true, revision: await this.#holdingsRevision(result) }
  }

  /** FX 汇率快照（契约 §3/§4；host.fetchFxRates 缺席 → 桥内兜底 fetcher）。 */
  async fx(base: string): Promise<FxRatesSnapshot & { ok: true }> {
    const normalized = base.trim().toUpperCase()
    if (!FX_BASES.includes(normalized)) {
      throw new BridgeProtocolError(400, `fx: unsupported base ${JSON.stringify(base)} (supported: ${FX_BASES.join('/')})`)
    }
    const fetcher = this.host.fetchFxRates ?? this.#fallbackFxFetcher
    const snap = await fetcher(normalized)
    return { ok: true, base: snap.base, rates: snap.rates, asOf: snap.asOf, stale: snap.stale }
  }

  /**
   * 标的新闻与公告聚合（issue #37）：按市场从 newsRegistry 解析到 Kit 注册的
   * 聚合器；未注册时回退到各 Kit 导出的 aggregateNews 纯函数（无活跃会话时亦可用）。
   * 只返回与标的相关的条目（2026-09-03 owner 裁决）：无相关新闻/公告就返回空列表，
   * 不再回退展示大盘要闻——此前的智能回退会把已抓到的公告挤出 limit 截尾窗。
   */
  async news(market: string, symbol: string | null, rawLimit: string | null): Promise<NewsWire> {
    const id = this.#requireMarketId(market)
    const aggregator = this.host.newsRegistry?.get(id)
      ?? (id === 'cn' ? aggregateCnNews
        : id === 'hk' ? aggregateHkNews
        : id === 'us' ? aggregateUsNews
        : id === 'crypto' ? aggregateCryptoNews
        : undefined)

    if (aggregator === undefined) {
      throw Object.assign(
        new Error(`market ${market} does not have a news provider`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    const limit = rawLimit === null || rawLimit === undefined ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_NEWS_LIMIT)) {
      throw new BridgeProtocolError(400, `news: limit must be an integer in 1..${MAX_NEWS_LIMIT}`)
    }
    const result = await aggregator({
      symbol: symbol ?? undefined,
      limit: limit ?? 20,
      windowHours: 24,
      cryptoPanicKey: this.host.newsKey?.(),
      sources: this.host.newsSources?.(id),
    })

    return { ok: true, items: result.items, unavailable: result.unavailable }
  }

  /**
   * 跨市场快讯（金十接入，2026-09-13）：host 面 tradingFlashFeed 服务提供，
   * 未安装/未启用 → TRADING_NOT_IMPLEMENTED（不是空列表）。
   * keyword 命中上游搜索（一次性返回、不支持翻页）；否则按 cursor 翻最新流。
   * hot 为逗号分隔的热度等级（火/热/沸/爆），非空时 host 面走金十网页版服务端过滤。
   */
  async flash(rawCursor: string | null, rawLimit: string | null, rawKeyword: string | null, rawHot: string | null = null): Promise<FlashWire> {
    const feed = this.host.flashFeed
    if (feed === undefined) {
      throw Object.assign(
        new Error('flash feed is not mounted (install/enable the jin10 connector)'),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    const limit = rawLimit === null || rawLimit === '' ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_FLASH_LIMIT)) {
      throw new BridgeProtocolError(400, 'flash: limit must be an integer in 1..' + MAX_FLASH_LIMIT)
    }
    const keyword = rawKeyword === null ? '' : rawKeyword.trim()
    if (keyword.length > 0) {
      const items = await feed.searchFlash(keyword, limit ?? 30)
      return { ok: true, items, hasMore: false }
    }
    const hot = parseFlashHeat(rawHot)
    const page = await feed.listFlash({
      ...(rawCursor !== null && rawCursor !== '' ? { cursor: rawCursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(hot.length > 0 ? { hot } : {}),
    })
    return {
      ok: true,
      items: page.items,
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    }
  }

  /**
   * 宏观经济日历（金十接入，2026-09-15）：host 面 tradingMacroFeed 服务提供，
   * 未安装/未启用 → TRADING_NOT_IMPLEMENTED（不是空列表）。条目只含元数据
   * （时间/星级/地区/标题/数值快照），地区为标题前缀推断（上游无 country 参数）。
   */
  async macroCalendar(rawLimit: string | null): Promise<MacroCalendarWire> {
    const feed = this.host.macroFeed
    if (feed === undefined) {
      throw Object.assign(
        new Error('macro feed is not mounted (install/enable the jin10 connector)'),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    const limit = rawLimit === null || rawLimit === '' ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_MACRO_CALENDAR_LIMIT)) {
      throw new BridgeProtocolError(400, 'macro/calendar: limit must be an integer in 1..' + MAX_MACRO_CALENDAR_LIMIT)
    }
    return { ok: true, items: await feed.listCalendar(limit) }
  }

  /** 央行最新利率（金十网页版，全量 30 家；地区过滤在客户端）。 */
  async macroRates(): Promise<MacroRatesWire> {
    const feed = this.host.macroFeed
    if (feed === undefined) {
      throw Object.assign(
        new Error('macro feed is not mounted (install/enable the jin10 connector)'),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return { ok: true, items: await feed.listRates() }
  }

  /**
   * FOMC 决议路径档位与隐含概率（Polymarket 接入，2026-10-11）：host 面
   * tradingPredictionFeed 服务提供，未安装/未启用 → TRADING_NOT_IMPLEMENTED
   * （不是空列表——「没装数据源」与「确实没有数据」必须可区分）。
   *
   * 只读透传：桥不做缓存、不算概率（口径由连接器按 spike 裁决实现，单一来源）。
   */
  async predictionFomc(): Promise<PredictionWire> {
    const feed = this.host.predictionFeed
    if (feed === undefined) {
      throw Object.assign(
        new Error('prediction feed is not mounted (install/enable the polymarket connector)'),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    const feedSnapshot = await feed.listFomcMeetings()
    return { ok: true, fetchedAt: feedSnapshot.fetchedAt, meetings: feedSnapshot.meetings }
  }


  /** 自定义策略名册（issue #31）：返回记录（含内置覆盖记录），前端校验后并入名册。 */
  async customStrategies(): Promise<{ ok: boolean; strategies: CustomStrategyRecord[] }> {
    const store = this.host.strategyStore
    if (store === undefined) return { ok: true, strategies: [] }
    const strategies = await store.list()
    return { ok: true, strategies }
  }

  /**
   * 删除策略（策略管理）：自定义 = 移除记录；内置范式 = 落墓碑（出厂代码不动，
   * POST /strategies/reset 可恢复），顺带丢弃该内置的覆盖记录。
   */
  async deleteCustomStrategy(rawId: string): Promise<{ ok: boolean; removed: boolean; scope: 'custom' | 'builtin' }> {
    // 与 PUT 同款归一化（PUT 在 isBuiltinStrategyId 前先 trim+lowercase，两侧对称）。
    const id = rawId.trim().toLowerCase()
    if (isBuiltinStrategyId(id)) {
      await this.host.tombstonesStore?.add(id)
      // 内置删除丢弃覆盖记录：归档后可找回（出厂代码由墓碑/恢复语义保证）。
      await this.host.strategyStore?.remove(id, true)
      return { ok: true, removed: true, scope: 'builtin' }
    }
    const store = this.host.strategyStore
    if (store === undefined) return { ok: true, removed: false, scope: 'custom' }
    const removed = await store.remove(id)
    return { ok: true, removed, scope: 'custom' }
  }

  /**
   * 保存自定义策略（策略管理，PUT /strategies/custom）：桥侧 vm 沙箱全量校验
   * （结构/语法/多场景试算/信号序列）通过才落盘。同 id 既有自定义记录即 upsert
   * 覆盖；id 命中内置范式 = 覆盖内置，必须显式带 overridesBuiltin 确认位
   * （防 GUI 误覆盖），成功时顺带清除该 id 的删除墓碑。
   */
  async saveCustomStrategy(body: unknown): Promise<
    | { ok: true; strategy: CustomStrategyRecord; overridesBuiltin: boolean }
    | { ok: false; code: string; message: string }
  > {
    const store = this.host.strategyStore
    if (store === undefined) {
      return { ok: false, code: 'TRADING_STRATEGY_UNAVAILABLE', message: 'strategy store is not mounted' }
    }
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
    const overridesBuiltin = isBuiltinStrategyId(id)
    if (overridesBuiltin && input.overridesBuiltin !== true) {
      return {
        ok: false,
        code: 'TRADING_STRATEGY_OVERRIDE_CONFIRM',
        message: `id "${id}" is a built-in paradigm strategy — pass overridesBuiltin:true to confirm overriding it`,
      }
    }
    const result = await validateCustomStrategyNode(input)
    if (!result.ok) {
      return { ok: false, code: 'TRADING_STRATEGY_INVALID', message: result.reason }
    }
    if (overridesBuiltin) {
      await this.host.tombstonesStore?.remove(id)
      // 上一次覆盖记录将被本次 save 顶掉：先归档删除再落盘，旧修改可找回。
      const previousOverride = await store.get(id)
      if (previousOverride !== undefined) await store.remove(id, true)
    }
    await store.save(result.record)
    return { ok: true, strategy: result.record, overridesBuiltin }
  }

  /** 内置删除墓碑清单（策略管理；GUI 据此展示灰卡与恢复入口）。 */
  async builtinTombstones(): Promise<{ ok: boolean; deleted: string[] }> {
    const deleted = await this.host.tombstonesStore?.list() ?? []
    return { ok: true, deleted }
  }

  /**
   * 恢复内置策略出厂默认（策略管理，POST /strategies/reset）：清覆盖记录与墓碑。
   * 自定义策略无出厂版本 → 业务拒绝。
   */
  async resetStrategy(id: string): Promise<
    | { ok: true; reset: true; changed: boolean; removedOverride: boolean; liftedTombstone: boolean }
    | { ok: false; code: string; message: string }
  > {
    if (!isBuiltinStrategyId(id)) {
      return { ok: false, code: 'TRADING_STRATEGY_NOT_BUILTIN', message: `"${id}" is not a built-in paradigm strategy id` }
    }
    // 恢复出厂丢弃覆盖记录：归档后可找回。
    const removedOverride = await this.host.strategyStore?.remove(id, true) ?? false
    const liftedTombstone = await this.host.tombstonesStore?.remove(id) ?? false
    return { ok: true, reset: true, changed: removedOverride || liftedTombstone, removedOverride, liftedTombstone }
  }

  /** 自定义选股器名册（选股器管理）：返回记录（含内置覆盖记录），前端校验后并入名册。 */
  async customScreeners(): Promise<{ ok: boolean; screeners: CustomScreenerRecord[] }> {
    const store = this.host.screenerStore
    if (store === undefined) return { ok: true, screeners: [] }
    const screeners = await store.list()
    return { ok: true, screeners }
  }

  /**
   * 保存自定义选股器（选股器管理，PUT /strategies/screeners）：桥侧 vm 沙箱全量
   * 校验（结构/语法/多场景试算/ScreenerMatch 形状）通过才落盘。id 命中内置选股器
   * = 覆盖内置，必须显式带 overridesScreener 确认位，成功时顺带清除删除墓碑。
   */
  async saveCustomScreener(body: unknown): Promise<
    | { ok: true; screener: CustomScreenerRecord; overridesScreener: boolean }
    | { ok: false; code: string; message: string }
  > {
    const store = this.host.screenerStore
    if (store === undefined) {
      return { ok: false, code: 'TRADING_SCREENER_UNAVAILABLE', message: 'screener store is not mounted' }
    }
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
    const overridesScreener = isBuiltinScreenerId(id)
    if (overridesScreener && input.overridesScreener !== true) {
      return {
        ok: false,
        code: 'TRADING_SCREENER_OVERRIDE_CONFIRM',
        message: `id "${id}" is a built-in screener — pass overridesScreener:true to confirm overriding it`,
      }
    }
    const result = await validateCustomScreenerNode(input)
    if (!result.ok) {
      return { ok: false, code: 'TRADING_SCREENER_INVALID', message: result.reason }
    }
    if (overridesScreener) {
      await this.host.tombstonesStore?.remove(id)
      // 上一次覆盖记录将被本次 save 顶掉：先归档删除再落盘，旧修改可找回。
      const previousOverride = await store.get(id)
      if (previousOverride !== undefined) await store.remove(id, true)
    }
    await store.save(result.record)
    return { ok: true, screener: result.record, overridesScreener }
  }

  /**
   * 删除选股器（选股器管理）：自定义 = 移除记录；内置 = 落墓碑（恢复出厂走
   * POST /strategies/screeners/reset），顺带丢弃该内置的覆盖记录。
   */
  async deleteCustomScreener(rawId: string): Promise<{ ok: boolean; removed: boolean; scope: 'custom' | 'builtin' }> {
    // 与 PUT 同款归一化（与 deleteCustomStrategy 对称）。
    const id = rawId.trim().toLowerCase()
    if (isBuiltinScreenerId(id)) {
      await this.host.tombstonesStore?.add(id)
      // 内置删除丢弃覆盖记录：归档后可找回。
      await this.host.screenerStore?.remove(id, true)
      return { ok: true, removed: true, scope: 'builtin' }
    }
    const store = this.host.screenerStore
    if (store === undefined) return { ok: true, removed: false, scope: 'custom' }
    const removed = await store.remove(id)
    return { ok: true, removed, scope: 'custom' }
  }

  /** 恢复内置选股器出厂默认（选股器管理）：清覆盖记录与墓碑；自定义 → 业务拒绝。 */
  async resetScreener(id: string): Promise<
    | { ok: true; reset: true; changed: boolean; removedOverride: boolean; liftedTombstone: boolean }
    | { ok: false; code: string; message: string }
  > {
    if (!isBuiltinScreenerId(id)) {
      return { ok: false, code: 'TRADING_SCREENER_NOT_BUILTIN', message: `"${id}" is not a built-in screener id` }
    }
    // 恢复出厂丢弃覆盖记录：归档后可找回。
    const removedOverride = await this.host.screenerStore?.remove(id, true) ?? false
    const liftedTombstone = await this.host.tombstonesStore?.remove(id) ?? false
    return { ok: true, reset: true, changed: removedOverride || liftedTombstone, removedOverride, liftedTombstone }
  }

  /**
   * 「TTL 命中 → 同键在途去重 → 取数 → 写缓存 → 清在途」协议（fundamentals 与
   * southbound 共用一处；此前两份各自把这段重写过一遍）：成功 → 写缓存并返回；
   * 失败 → 清在途、不写缓存、原样抛出（错误不进缓存，下一次请求重试上游）。
   */
  async #cachedFetch<V>(
    cache: TtlCache<V>,
    inflight: Map<string, Promise<V>>,
    key: string,
    load: () => Promise<V>,
  ): Promise<V> {
    const cached = cache.getFresh(key, Date.now())
    if (cached !== undefined) return cached
    const pending = inflight.get(key)
    if (pending !== undefined) return await pending
    const job = (async (): Promise<V> => {
      const value = await load()
      cache.set(key, value, Date.now())
      return value
    })()
    inflight.set(key, job)
    try {
      return await job
    } finally {
      inflight.delete(key)
    }
  }

  /**
   * 标的基本面快照与多期财务矩阵（GUI「基本面」页签，2026-09-02 / Issue #36）。
   *
   * 语义（重构自协作者初版，2026-09-02 审查整改）：
   * - 数据包（kit 的多期报表/股东/分红等下钻）直接按市场取，不要求连接器实现
   *   getFundamentals——us/crypto 由此可达；快照部分为可选增强（连接器实现了才合并）。
   * - 快照与数据包并行取（Promise.all）；任一失败只降级自己那半，另一半照常返回。
   * - 两个都失败 → TRADING_NOT_IMPLEMENTED 业务错误（HTTP 200 + ok:false），
   *   前端显示诚实空态；不再有「半旧数据冒充新标的」的路径。
   * - 5 分钟进程内 TTL 缓存（财报级数据，非 tick）+ 同键 in-flight 去重，
   *   对齐本桥 symbols() 的缓存先例；一次 tab 翻转只打一轮上游。
   */
  async fundamentals(market: string, symbol: string): Promise<FundamentalsWire> {
    const id = this.#requireMarketId(market)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'fundamentals: symbol is required')
    const service = this.#requireMarketService(id)

    const cacheKey = `${market}:${trimmed}`
    const result = await this.#cachedFetch(
      this.fundamentalsCache,
      this.fundamentalsInflight,
      cacheKey,
      async (): Promise<StockFundamentals> => {
        const [snapshot, pkg] = await Promise.all([
          typeof service.getFundamentals === 'function'
            ? service.getFundamentals(trimmed).catch(() => undefined)
            : Promise.resolve(undefined),
          this.#fetchPkg(id, trimmed),
        ])
        if (snapshot === undefined && pkg === undefined) {
          throw Object.assign(
            new Error(`no fundamentals data for ${market}/${trimmed} — provider and drill-down both unavailable`),
            { code: 'TRADING_NOT_IMPLEMENTED' },
          )
        }
        // 合并语义：pkg 是骨架（含 market/symbol），snapshot 只增强 stock 字段；
        // 只有快照没有 pkg 时，快照自身就是返回值（含 timestamp，满足契约必填）。
        return pkg !== undefined
          ? ({
              ...pkg,
              stock: { ...(pkg.stock ?? {}), ...(snapshot ?? {}) },
              timestamp: snapshot?.timestamp ?? Date.now(),
            } as unknown as StockFundamentals)
          : snapshot as StockFundamentals
      },
    )
    return { ok: true, fundamentals: result }
  }

  /**
   * 港股通持股历史（GUI「港股通持股比例」副图，2026-10-13；契约 C §4）。
   *
   * 解析顺序冻结（按能力跨 provider，不按 router 当前值）：
   * 1. registry.active(market) 的服务实现了 getSouthboundHoldings → 用之；
   * 2. 否则扫 registry.list(market)，**按 provider 名排序稳定遍历**，取第一个实现了
   *    该方法的服务——本机 hk 路由指向 tencent（无此能力）、eastmoney 已注册但非
   *    active，正是这条路径的存在理由；active 命中但方法缺失时同样落到这里；
   * 3. 都没有 → TRADING_NOT_IMPLEMENTED 业务错误（HTTP 200 + ok:false），前端隐藏副图。
   *
   * 缓存照抄 fundamentals：5 分钟进程内 TTL + 同键 in-flight 去重，副图随级别
   * 切换反复取数，一次翻转只打一轮上游。语义区分（契约 A）：标的不在港股通范围
   * → 服务回 { points: [] }，桥如实透传（空 ≠ 0，不伪造成 0 点）；上游失败 →
   * 原样抛错，交给 HTTP 层下发生成业务错误。
   */
  async southboundHoldings(market: string, symbol: string): Promise<SouthboundHoldingsWire> {
    const id = this.#requireMarketId(market)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'southboundHoldings: symbol is required')
    const service = this.#resolveSouthboundService(id)
    if (service === undefined) {
      throw Object.assign(
        new Error(`no southbound holdings source for ${market} — no provider implements getSouthboundHoldings`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }

    const cacheKey = `${market}:${trimmed}`
    const history = await this.#cachedFetch(
      this.southboundCache,
      this.southboundInflight,
      cacheKey,
      () => service.getSouthboundHoldings(trimmed),
    )
    return { ok: true, southboundHoldings: history }
  }

  /**
   * 主动买盘历史只读文件；非 cn 一律空序列，不解析服务或文件。
   * cn 按 active 优先、provider 名排序扫描注册项解析 live 能力；
   * 能力缺席/调用抛错/非今天均只返回历史，
   * 文件今天已有行时不注入 live。归并与 250 日截断规则归 active-buy 纯函数。
   */
  async activeBuy(market: string, symbol: string): Promise<ActiveBuyWire> {
    const trimmed = symbol.trim()
    if (market !== 'cn') return { ok: true, symbol: trimmed, points: [] }
    if (trimmed === '') throw new BridgeProtocolError(400, 'activeBuy: symbol is required')
    const { snapshots } = await readActiveBuySnapshots()
    let snapshot: ActiveBuySnapshot | undefined
    try {
      const service = this.#resolveActiveBuyService()
      if (service !== undefined) snapshot = await service.getActiveBuySnapshot(trimmed)
    } catch {
      // 可选盘中能力失败只保留文件历史，不报 500、不补零。
    }
    return mergeActiveBuyPoints(snapshots, trimmed, shanghaiDate(new Date()), snapshot)
  }

  /** 镜像 #resolveSouthboundService 的 active → provider 排序扫描；无能力保留历史。 */
  #resolveActiveBuyService(): ActiveBuyCapableService | undefined {
    const registry = this.host.marketRegistry
    const active = registry === undefined ? this.host.getMarketService('cn') : registry.active('cn')?.service
    if (hasActiveBuySnapshot(active)) return active
    const entries = [...(registry?.list?.('cn') ?? [])]
      .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
    for (const entry of entries) {
      if (hasActiveBuySnapshot(entry.service)) return entry.service
    }
    return undefined
  }

  /** 按能力解析港股通持股数据源（冻结顺序见 southboundHoldings；同族见 #resolveActiveBuyService）。 */
  #resolveSouthboundService(market: string): SouthboundCapableService | undefined {
    const registry = this.host.marketRegistry
    const active = registry?.active(market)?.service
    if (hasSouthboundHoldings(active)) return active
    // active 缺席或命中但方法缺失：扫同市场注册项，按 provider 名排序取第一个有能力的。
    const capable = [...(registry?.list?.(market) ?? [])]
      .filter((entry): entry is { provider: string; service: SouthboundCapableService } => hasSouthboundHoldings(entry.service))
      .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
    return capable[0]?.service
  }

  /** 按市场拉 kit 基本面数据包；kit 未覆盖或上游失败 → undefined（不算错误）。 */
  async #fetchPkg(market: MarketId, symbol: string): Promise<FundamentalsPackage | undefined> {
    try {
      const pkg = market === 'cn' ? await fetchCnFundamentalsPackage(symbol)
        : market === 'hk' ? await fetchHkFundamentalsPackage(symbol)
        : market === 'us' ? await fetchUsFundamentalsPackage(symbol)
        : market === 'crypto' ? await fetchCryptoFundamentalsPackage(symbol)
        : undefined
      // 骨架包（全部上游失败时 kit 仍返回 market/symbol + 空数组）不算数据：
      // 只有携带实质下钻（matrix/stock/profile 详情/股东等任一）才压过快照，
      // 否则快照字段会被空骨架挤到 stock 子对象里丢掉顶层估值字段。
      if (pkg === undefined) return undefined
      const hasSubstance = pkg.matrix !== undefined
        || pkg.stock !== undefined
        || pkg.crypto !== undefined
        || pkg.profile?.description !== undefined
        || pkg.profile?.industry !== undefined
        || (pkg.shareholders?.length ?? 0) > 0
        || (pkg.reports?.length ?? 0) > 0
        || (pkg.mainOperations?.length ?? 0) > 0
        || (pkg.dividends?.length ?? 0) > 0
        || pkg.forecast !== undefined
        || pkg.holderSummary !== undefined
        || pkg.efficiency !== undefined
        || (pkg.insiderTrades?.length ?? 0) > 0
        || (pkg.institutionalHoldings?.length ?? 0) > 0
        || (pkg.dividends?.length ?? 0) > 0
        || (pkg.splits?.length ?? 0) > 0
      return hasSubstance ? pkg : undefined
    } catch {
      // 下钻失败不阻断快照：调用方以 snapshot 兜底
    }
    return undefined
  }

  /* ---------------------------------------------------------------- */
  /* 自选股 + 选中（issue #32 / P3）：host store 为 SSOT，localStorage 降级镜像 */
  /* ---------------------------------------------------------------- */

  /** 全量读取自选行（不含客户端种子回退）。 */
  async watchlistRows(): Promise<{ ok: boolean; watchlists: WatchlistsMap }> {
    const store = this.host.watchlistStore
    if (store === undefined) return { ok: true, watchlists: {} }
    return { ok: true, watchlists: await store.list() }
  }

  /** 全量替换自选（客户端启动同步）。 */
  async replaceWatchlists(body: unknown): Promise<{ ok: boolean; watchlists: WatchlistsMap }> {
    const store = this.host.watchlistStore
    if (store === undefined) return { ok: true, watchlists: {} }
    const map = await this.dropUnknownGroups(parseWatchlistsMap(body))
    await store.save(map)
    return { ok: true, watchlists: await store.list() }
  }

  /**
   * 行上分组归属按注册表清洗（2026-09-08 审查 L4）：注册表里已不存在的 id 一律
   * 丢弃——成员端点会校验，行写端点此前不校验，可落悬挂 id（删组清理覆盖不到）。
   */
  private async filterKnownGroups(groups: readonly string[] | undefined): Promise<string[] | undefined> {
    if (groups === undefined || groups.length === 0) return undefined
    const store = this.host.groupsStore
    if (store === undefined) return undefined
    const known = new Set((await store.list()).map(group => group.id))
    const kept = groups.filter(id => known.has(id))
    return kept.length > 0 ? kept : undefined
  }

  /** 整表行上的分组归属按注册表清洗（PUT/import 全量写入口）。 */
  private async dropUnknownGroups(map: WatchlistsMap): Promise<WatchlistsMap> {
    if (this.host.groupsStore === undefined) return map
    const out: WatchlistsMap = {}
    for (const [market, rows] of Object.entries(map)) {
      out[market] = await Promise.all(rows.map(async (row) => {
        const groups = await this.filterKnownGroups(row.groups)
        return {
          market: row.market,
          symbol: row.symbol,
          ...(row.name !== undefined ? { name: row.name } : {}),
          ...(row.form !== undefined ? { form: row.form } : {}),
          ...(row.assetClass !== undefined ? { assetClass: row.assetClass } : {}),
          ...(groups !== undefined ? { groups } : {}),
        }
      }))
    }
    return out
  }

  /** 追加一行（POST /watchlists）。 */
  async addWatchlistRow(body: unknown): Promise<{ ok: boolean; added: boolean; instrument: WatchlistInstrument }> {
    const store = this.host.watchlistStore
    const parsed = parseInstrumentBody(body)
    const groups = await this.filterKnownGroups(parsed.groups)
    const instrument: WatchlistInstrument = {
      market: parsed.market,
      symbol: parsed.symbol,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.form !== undefined ? { form: parsed.form } : {}),
      ...(parsed.assetClass !== undefined ? { assetClass: parsed.assetClass } : {}),
      ...(groups !== undefined ? { groups } : {}),
    }
    if (store === undefined) return { ok: true, added: false, instrument }
    const added = await store.add(instrument.market, instrument)
    return { ok: true, added, instrument }
  }

  /** 移除一行（DELETE /watchlists?market&symbol）。 */
  async removeWatchlistRow(market: string, symbol: string): Promise<{ ok: boolean; removed: boolean }> {
    const store = this.host.watchlistStore
    if (store === undefined || !market || !symbol) return { ok: true, removed: false }
    const removed = await store.remove(market, symbol)
    return { ok: true, removed }
  }

  /**
   * 一次性迁移导入（POST /watchlists/import）：host 非空拒绝（幂等，防重复导入）。
   */
  async importWatchlists(body: unknown): Promise<{ ok: boolean; imported: boolean; reason?: string }> {
    const store = this.host.watchlistStore
    if (store === undefined) return { ok: false, imported: false, reason: 'watchlist store is not mounted' }
    const existing = await store.list()
    if (Object.keys(existing).length > 0) {
      return { ok: false, imported: false, reason: 'host watchlist store is not empty — migration already done (idempotent guard)' }
    }
    const map = await this.dropUnknownGroups(parseWatchlistsMap(body))
    await store.save(map)
    return { ok: true, imported: true }
  }

  /* ---------------------------------------------------------------- */
  /* 自定义分组（issue #82）：注册表 CRUD + 行级 membership              */
  /* ---------------------------------------------------------------- */

  /** 全量读取分组注册表（GET /watchlist-groups）。 */
  async watchlistGroups(): Promise<{ ok: boolean; groups: WatchlistGroup[] }> {
    const store = this.host.groupsStore
    if (store === undefined) return { ok: true, groups: [] }
    return { ok: true, groups: await store.list() }
  }

  /** 创建分组（POST /watchlist-groups，body { name }）；同名业务拒绝（ok:false + code）。 */
  async createWatchlistGroup(body: unknown): Promise<{ ok: boolean; created: boolean; group?: WatchlistGroup; code?: 'duplicate' | 'unavailable'; reason?: string }> {
    const store = this.host.groupsStore
    const name = parseGroupNameBody(body)
    if (store === undefined) return { ok: true, created: false, code: 'unavailable' }
    const result = await store.create(name)
    if (result.error === 'duplicate') {
      return { ok: false, created: false, code: 'duplicate', reason: `group name ${JSON.stringify(name)} already exists` }
    }
    if (result.group === undefined) {
      return { ok: false, created: false, code: 'unavailable', reason: 'watchlist group store returned no group' }
    }
    return { ok: true, created: true, group: result.group }
  }

  /**
   * 重命名分组（PUT /watchlist-groups，body { id, name }）。
   * `code` 是机器可读判据（审查 L4）：'not-found' 与 'duplicate' 的 reason 文案
   * 不同但都走 ok:false，客户端此前一律显示「名称已存在」。
   */
  async renameWatchlistGroup(body: unknown): Promise<{ ok: boolean; renamed: boolean; group?: WatchlistGroup; code?: 'duplicate' | 'not-found' | 'unavailable'; reason?: string }> {
    const store = this.host.groupsStore
    const raw = (body ?? {}) as { id?: unknown }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id) throw new BridgeProtocolError(400, 'rename watchlist group body requires string id')
    const name = parseGroupNameBody(body)
    if (store === undefined) return { ok: true, renamed: false }
    const result = await store.rename(id, name)
    if (result.error === 'not-found') return { ok: false, renamed: false, code: 'not-found', reason: `no such group id ${JSON.stringify(id)}` }
    if (result.error === 'duplicate') {
      return { ok: false, renamed: false, code: 'duplicate', reason: `group name ${JSON.stringify(name)} already exists` }
    }
    if (result.group === undefined) {
      return { ok: false, renamed: false, code: 'unavailable', reason: 'watchlist group store returned no group' }
    }
    return { ok: true, renamed: true, group: result.group }
  }

  /** 删除分组（DELETE /watchlist-groups?id=）：先清全表成员关系，再删注册表行。 */
  async removeWatchlistGroup(id: string): Promise<{ ok: boolean; removed: boolean }> {
    const store = this.host.groupsStore
    if (store === undefined || !id) return { ok: true, removed: false }
    if (this.host.watchlistStore !== undefined) await this.host.watchlistStore.stripGroup(id)
    const removed = await store.remove(id)
    return { ok: true, removed }
  }

  /**
   * 加入分组（POST /watchlist-group-members，body { id, market, symbol, name? }）：
   * 行缺席时物化（种子展示行入组场景——host store 未定制市场无行），随后写归属。
   */
  async addWatchlistGroupMember(body: unknown): Promise<{ ok: boolean; added: boolean; materialized: boolean; reason?: string }> {
    const groups = this.host.groupsStore
    const watchlists = this.host.watchlistStore
    if (groups === undefined) return { ok: true, added: false, materialized: false }
    const input = parseGroupMemberBody(body)
    // 组不存在即拒绝：否则行上留下悬挂 id（管理弹窗显示 '?' chip，删组清理也覆盖不到）。
    if (!(await groups.list()).some(group => group.id === input.id)) {
      return { ok: false, added: false, materialized: false, reason: `no such group id ${JSON.stringify(input.id)}` }
    }
    let materialized = false
    if (watchlists !== undefined) {
      const map = await watchlists.list()
      const rows = map[input.market]
      if (!Array.isArray(rows)) {
        // 未定制市场：整体物化该市场种子基线，目标行落分组归属（2026-09-08 审查
        // H2）。只物化单行会让「键存在 = 已定制」语义把该市场其余默认行判成已
        // 删除——侧栏与 watchlist_list 立刻少行。口径与 store.remove（种子兜底）
        // 和客户端 applyLocalMembership（同款物化）一致。
        const seeds = WATCHLIST_SEEDS[input.market] ?? []
        const baseline: WatchlistInstrument[] = seeds.map(row => ({
          market: row.market,
          symbol: row.symbol,
          ...(row.name !== undefined ? { name: row.name } : {}),
        }))
        if (!baseline.some(row => row.symbol === input.symbol)) {
          baseline.push({
            market: input.market,
            symbol: input.symbol,
            ...(input.name !== undefined ? { name: input.name } : {}),
          })
        }
        await watchlists.save({ ...map, [input.market]: baseline })
        materialized = true
      } else if (!rows.some(row => row.symbol === input.symbol)) {
        materialized = await watchlists.add(input.market, {
          market: input.market,
          symbol: input.symbol,
          ...(input.name !== undefined ? { name: input.name } : {}),
        })
      }
    }
    const added = watchlists !== undefined ? await watchlists.assignGroup(input.market, input.symbol, input.id, true) : false
    return { ok: true, added, materialized }
  }

  /** 移出分组（DELETE /watchlist-group-members?id&market&symbol）；只摘归属不删自选行。 */
  async removeWatchlistGroupMember(id: string, market: string, symbol: string): Promise<{ ok: boolean; removed: boolean }> {
    const groups = this.host.groupsStore
    const watchlists = this.host.watchlistStore
    if (groups === undefined || watchlists === undefined || !id || !market || !symbol) {
      return { ok: true, removed: false }
    }
    const removed = await watchlists.assignGroup(market, symbol, id, false)
    return { ok: true, removed }
  }

  /* ---------------------------------------------------------------- */
  /* 图表激活名册（issue #63）：host store 为 SSOT，localStorage 降级镜像  */
  /* ---------------------------------------------------------------- */

  /** 全量读取激活名册（GET /chart/indicators）。 */
  async chartActivations(): Promise<ChartActivationsWire> {
    const store = this.host.chartActivationsStore
    if (store === undefined) return { ok: true, instances: [] }
    return { ok: true, instances: await store.list() }
  }

  /**
   * 挂载/更新一个激活实例（PUT /chart/indicators，body { id, params?, market?, symbol?, clearSymbol?, visible? }）：
   * id 必须能解析为预置或自定义指标（未知 id 业务拒绝——与 GUI 可渲染集合同源）；
   * params 按 schema clamp，缺失键取 schema 默认值。
   * issue #72：body 同时带 market+symbol 时写入该标的的参数覆盖（symbolParams[
   * `${market}:${symbol}`]），clearSymbol:true 改为删除该覆盖；不带 scope 时写
   * 全局 params。两种写法都保留实例上已有的其他覆盖。market/symbol 只给其一是
   * 业务拒绝（TRADING_INVALID_SCOPE）；clearSymbol 对未挂载 id 是无操作不建实例。
   * symbol visibility：body 带 visible:boolean 时为可见性写——仅 market 即整市场
   * 隐藏/显示，market+symbol 为单标的；实例缺席为幂等 no-op 不反向创建；visible
   * 优先于 params/clearSymbol（同请求带 params 时被忽略）。
   * 适用范围：body 带 applyScope:object 时为适用范围写——整表替换该实例的
   * applyScope（空表清空该字段，落回「全部市场、全部级别应用」），不触碰 params/
   * symbolParams/hiddenScopes；实例缺席为幂等 no-op 不反向创建；applyScope 优先于
   * params/clearSymbol。
   */
  async putChartActivation(body: unknown): Promise<ChartActivationsWire | ChartActivationRejectedWire> {
    const store = this.host.chartActivationsStore
    const raw = (body ?? {}) as { id?: unknown; params?: unknown; market?: unknown; symbol?: unknown; clearSymbol?: unknown; visible?: unknown; applyScope?: unknown }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id) throw new BridgeProtocolError(400, 'chart activation body requires string id')
    const spec = await resolveIndicatorSpec(id, this.host.customIndicatorsStore)
    if (spec === undefined) {
      return {
        ok: false,
        code: 'TRADING_UNKNOWN_INDICATOR',
        message: 'unknown indicator id ' + JSON.stringify(id) + ' — presets and authored custom ids only (see indicator_list)',
      }
    }
    const overrides: Record<string, number> = {}
    if (typeof raw.params === 'object' && raw.params !== null && !Array.isArray(raw.params)) {
      for (const [key, value] of Object.entries(raw.params as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) overrides[key] = value
      }
    }
    const params = clampActivationParams(spec.params, overrides)
    const market = typeof raw.market === 'string' ? raw.market.trim() : ''
    const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
    const hasVisible = typeof raw.visible === 'boolean'
    const scope = market !== '' && symbol !== '' ? symbolScopeKey(market, symbol) : undefined
    if (scope === undefined && !hasVisible && (market !== '' || symbol !== '')) {
      // 与 indicator_activate 工具同规则：params 覆盖只收成对 market+symbol，
      // 半参业务拒绝而非静默落全局（全局写影响所有标的）。可见性写例外：仅
      // market 合法（整市场隐藏/显示）。
      return {
        ok: false,
        code: 'TRADING_INVALID_SCOPE',
        message: 'market and symbol must be supplied together (or neither) — got market='
          + JSON.stringify(market) + ', symbol=' + JSON.stringify(symbol),
      }
    }
    const existing = store !== undefined ? (await store.list()).find(instance => instance.id === id) : undefined

    if (hasVisible) {
      // 可见性写：实例缺席为幂等 no-op（隐藏未挂载指标无意义，不反向创建）。
      if (market === '') {
        return { ok: false, code: 'TRADING_INVALID_SCOPE', message: 'visibility write requires market (optionally symbol)' }
      }
      if (existing === undefined) {
        return { ok: true, instances: store !== undefined ? await store.list() : [] }
      }
      const hideScope = symbol !== '' ? symbolScopeKey(market, symbol) : market
      const next = withHiddenScopes(existing, hideScope, raw.visible === true)
      // existing 来自 store.list()，存在即 store 已定义；此处守卫只为类型窄化。
      if (store !== undefined && next !== existing) await store.activate(next)
      return { ok: true, instances: store !== undefined ? await store.list() : [next] }
    }

    // 适用范围写（先于 params/覆盖写）：整表替换，实例缺席幂等 no-op。
    if (raw.applyScope !== undefined) {
      if (existing === undefined) {
        return { ok: true, instances: store !== undefined ? await store.list() : [] }
      }
      const applyScope = parseApplyScope(raw.applyScope)
      const next = Object.keys(applyScope).length > 0
        ? { ...existing, applyScope }
        : (() => { const rest = { ...existing }; delete rest.applyScope; return rest })()
      if (store !== undefined && next !== existing) await store.activate(next)
      return { ok: true, instances: store !== undefined ? await store.list() : [next] }
    }

    let instance: IndicatorInstance
    if (scope !== undefined) {
      // 清除不存在的覆盖是无操作：不反向创建激活实例。
      if (raw.clearSymbol === true && existing === undefined) {
        return { ok: true, instances: store !== undefined ? await store.list() : [] }
      }
      // 新实例的全局 params 取 schema 默认值——首个标的的覆盖不得泄漏成全局值。
      // 新建实例同时带上 definition 声明的默认适用范围（决策 7）；既有实例以自己
      // 为起点，用户清空适用范围后不会被补回。
      const base: IndicatorInstance = existing ?? defaultActivationInstance(spec)
      const symbolParams: Record<string, Record<string, number>> = { ...(base.symbolParams ?? {}) }
      if (raw.clearSymbol === true) delete symbolParams[scope]
      else symbolParams[scope] = params
      // 覆盖表按本次计算结果落地（clearSymbol 清空后字段整体消失，不得从 base 继承
      // 回来）；hiddenScopes 与 applyScope 与覆盖表正交，必须随写保留。
      instance = {
        id,
        params: base.params,
        ...(Object.keys(symbolParams).length > 0 ? { symbolParams } : {}),
        ...(base.hiddenScopes !== undefined ? { hiddenScopes: base.hiddenScopes } : {}),
        ...(base.applyScope !== undefined ? { applyScope: base.applyScope } : {}),
      }
    } else {
      // 全局 params 写：保留已有按标的覆盖、隐藏表与适用范围（旧行为整体覆盖会抹掉它们）。
      // base 只在新建时是 definition 默认实例（携带默认适用范围）；既有实例缺席即
      // 缺席——用户显式清空适用范围后，重复写 params 不得把它补回来。
      const base: IndicatorInstance = existing ?? defaultActivationInstance(spec)
      instance = carryInstanceExtras(base, { id, params })
    }
    if (store !== undefined) await store.activate(instance)
    return { ok: true, instances: store !== undefined ? await store.list() : [instance] }
  }

  /** 摘除一个激活实例（DELETE /chart/indicators?id=）。 */
  async removeChartActivation(id: string): Promise<{ ok: boolean; removed: boolean; instances: IndicatorInstance[] }> {
    const store = this.host.chartActivationsStore
    if (store === undefined) return { ok: true, removed: false, instances: [] }
    const removed = await store.deactivate(id)
    return { ok: true, removed, instances: await store.list() }
  }

  /**
   * 一次性迁移导入（POST /chart/indicators/import）：host 非空拒绝（幂等，防重复导入）。
   * 客户端把 localStorage 存量激活名册搬进 host SSOT（issue #32 watchlist 同款）。
   */
  async importChartActivations(body: unknown): Promise<{ ok: boolean; imported: boolean; reason?: string }> {
    const store = this.host.chartActivationsStore
    if (store === undefined) return { ok: false, imported: false, reason: 'chart activation store is not mounted' }
    const existing = await store.list()
    if (existing.length > 0) {
      return { ok: false, imported: false, reason: 'host chart activation store is not empty — migration already done (idempotent guard)' }
    }
    const instances = parseChartInstances(body)
    await store.replaceAll(instances)
    return { ok: true, imported: true }
  }

  /** 读取选中标的（GET /selection）。 */
  async selection(): Promise<{ ok: boolean; instrument: WatchlistInstrument | null }> {
    const store = this.host.selectionStore
    if (store === undefined) return { ok: true, instrument: null }
    const record = await store.get()
    return { ok: true, instrument: record.instrument }
  }

  /** 设置选中标的（PUT /selection；watchlist_select 工具与左栏点击同源）。 */
  async putSelection(body: unknown): Promise<{ ok: boolean; instrument: WatchlistInstrument | null }> {
    const store = this.host.selectionStore
    const parsed = body as { instrument?: (WatchlistInstrument & { form?: unknown; assetClass?: unknown }) | null } | undefined
    const form = parsed?.instrument == null ? undefined : parseFormField(parsed.instrument.form)
    const assetClass = parsed?.instrument == null ? undefined : parseAssetClassField(parsed.instrument.assetClass)
    const instrument = parsed?.instrument === undefined || parsed.instrument === null
      ? null
      : {
        market: String(parsed.instrument.market ?? ''),
        symbol: String(parsed.instrument.symbol ?? ''),
        ...(parsed.instrument.name !== undefined ? { name: String(parsed.instrument.name) } : {}),
        ...(form !== undefined ? { form } : {}),
        ...(assetClass !== undefined ? { assetClass } : {}),
      }
    if (store === undefined) return { ok: true, instrument }
    await store.set({ instrument })
    return { ok: true, instrument }
  }
}

/** 自选 map 的形状校验（Record<market, Instrument[]>，宽容 name 缺省；groups 多归属放行）。 */
function parseWatchlistsMap(body: unknown): WatchlistsMap {
  if (typeof body !== 'object' || body === null) {
    throw new BridgeProtocolError(400, 'watchlists body must be an object')
  }
  const raw = (body as { watchlists?: unknown }).watchlists ?? body
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BridgeProtocolError(400, 'watchlists must be an object keyed by market')
  }
  const out: WatchlistsMap = {}
  for (const [market, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue
    out[market] = rows.map((row) => {
      const r = row as { market?: unknown; symbol?: unknown; name?: unknown; groups?: unknown; form?: unknown; assetClass?: unknown }
      if (typeof r?.symbol !== 'string' || !r.symbol) {
        throw new BridgeProtocolError(400, `watchlists[${market}] rows must have string symbol`)
      }
      const groups = parseGroupsField(r.groups)
      const form = parseFormField(r.form)
      const assetClass = parseAssetClassField(r.assetClass)
      return {
        market: typeof r.market === 'string' ? r.market : market,
        symbol: r.symbol,
        ...(typeof r.name === 'string' && r.name ? { name: r.name } : {}),
        ...(form !== undefined ? { form } : {}),
        ...(assetClass !== undefined ? { assetClass } : {}),
        ...(groups !== undefined ? { groups } : {}),
      }
    })
  }
  return out
}

/** 单行 instrument 的形状校验（groups 放行——GUI 分组视图下添加标的直落归属）。 */
function parseInstrumentBody(body: unknown): WatchlistInstrument {
  const raw = (body ?? {}) as { market?: unknown; symbol?: unknown; name?: unknown; groups?: unknown; form?: unknown; assetClass?: unknown }
  const market = typeof raw.market === 'string' ? raw.market.trim() : ''
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
  if (!market || !symbol) {
    throw new BridgeProtocolError(400, 'instrument body requires string market and symbol')
  }
  const groups = parseGroupsField(raw.groups)
  const form = parseFormField(raw.form)
  const assetClass = parseAssetClassField(raw.assetClass)
  return {
    market,
    symbol,
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
    ...(form !== undefined ? { form } : {}),
    ...(assetClass !== undefined ? { assetClass } : {}),
    ...(groups !== undefined ? { groups } : {}),
  }
}

/**
 * 形态/资产类别词汇的穷举表（2026-10-08 加密永续与 TradFi 永续落地）：词汇家在
 * `@dshtrading/api`，这里用 `Record<联合, true>` 承接——联合增删字面量时本文件编译不过，
 * 因此不会悄悄落后于契约（不是第二份手写清单）。
 */
const INSTRUMENT_FORM_MEMBERS: Record<InstrumentForm, true> = { spot: true, perp: true }
const INSTRUMENT_ASSET_CLASS_MEMBERS: Record<InstrumentAssetClass, true> = {
  crypto: true,
  equity: true,
  commodity: true,
  index: true,
}

/** 形态字段放行（未知字面量丢弃：展示元数据，不猜、不报错）。 */
function parseFormField(raw: unknown): InstrumentForm | undefined {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(INSTRUMENT_FORM_MEMBERS, raw)
    ? raw as InstrumentForm
    : undefined
}

/** 资产类别字段放行（同上；交易所元数据取不到即留空，禁止按符号猜）。 */
function parseAssetClassField(raw: unknown): InstrumentAssetClass | undefined {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(INSTRUMENT_ASSET_CLASS_MEMBERS, raw)
    ? raw as InstrumentAssetClass
    : undefined
}

/** 行上 groups 字段清洗（issue #82）：只收非空字符串 id，去重截断封顶 32。 */
function parseGroupsField(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item === 'string' && item) seen.add(item)
  }
  return seen.size > 0 ? [...seen].slice(0, 32) : undefined
}

/** 分组名字段校验：trim 非空、≤ 24 字符（协议层 400）。 */
function parseGroupNameBody(body: unknown): string {
  const raw = (body ?? {}) as { name?: unknown }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) throw new BridgeProtocolError(400, 'watchlist group body requires non-empty string name')
  if (name.length > 24) throw new BridgeProtocolError(400, 'watchlist group name too long (24 chars max)')
  return name
}

/** 分组成员写参数校验（body { id, market, symbol, name? }；name 供行物化兜底展示）。 */
function parseGroupMemberBody(body: unknown): { id: string; market: string; symbol: string; name?: string } {
  const raw = (body ?? {}) as { id?: unknown; market?: unknown; symbol?: unknown; name?: unknown }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const market = typeof raw.market === 'string' ? raw.market.trim() : ''
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
  if (!id || !market || !symbol) {
    throw new BridgeProtocolError(400, 'group member body requires string id, market and symbol')
  }
  return {
    id,
    market,
    symbol,
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
  }
}

/**
 * 适用范围写入的形状清洗（PUT applyScope）：形状不合格的市场条目**整条丢弃**
 * （落到「该市场缺席 = 全部级别应用」），绝不把坏值读成「未选级别」而静默停用。
 * 全部条目被丢弃即返回空表，调用方按「清空该字段」处理。清洗规则与读侧
 * sanitizeInstance 共用 @dshtrading/indicators 的 sanitizeApplyScope 单一实现。
 */
function parseApplyScope(raw: unknown): IndicatorApplyScope {
  return sanitizeApplyScope(raw) ?? {}
}

/**
 * 激活名册迁移导入的形状校验（{ instances: [...] } 或裸数组）：坏形行丢弃、
 * params 只收有限数字（host 侧参数 clamp 在 put 语义里，迁移保真原样搬运）。
 */
function parseChartInstances(body: unknown): IndicatorInstance[] {
  const raw = typeof body === 'object' && body !== null && Array.isArray((body as { instances?: unknown }).instances)
    ? (body as { instances: unknown[] }).instances
    : Array.isArray(body)
      ? body
      : []
  const out: IndicatorInstance[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const id = (item as { id?: unknown }).id
    const params = (item as { params?: unknown }).params
    if (typeof id !== 'string' || id.trim() === '') continue
    if (typeof params !== 'object' || params === null) continue
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value
    }
    // 行保留语义不变（脏值清洗成空 params），symbolParams/hiddenScopes/applyScope
    // 经 sanitizeInstance 保真（issue #72 / symbol visibility / 适用范围）。
    const normalized = sanitizeInstance({
      id,
      params: clean,
      symbolParams: (item as { symbolParams?: unknown }).symbolParams,
      hiddenScopes: (item as { hiddenScopes?: unknown }).hiddenScopes,
      applyScope: (item as { applyScope?: unknown }).applyScope,
    })
    if (normalized !== undefined) out.push(normalized)
  }
  return out
}

/* ---------------------------------------------------------------- */
/* 写路由声明表（第 2 项单一真值）：失效 store 与路由写在同一处            */
/* ---------------------------------------------------------------- */

/**
 * 写成功时需要客户端失效重拉的 store 名。值域 ⊆ @dshtrading/eventbus 的
 * TradingEventStore（客户端按 store 名重拉对应读面）。
 */
export type BridgeInvalidateStore = 'indicators' | 'chart' | 'strategies' | 'watchlists' | 'selection' | 'holdings'

/**
 * 路由结果：写路由必带 `invalidates`（来自声明表；「不失效任何 store」显式写成空表）；
 * 读路由（GET）不带该字段——GET 不失效任何 store 是类型事实，不是省略。
 * 调用方只在「写成功」（status 200 且 payload.ok === true）时消费 invalidates。
 */
export type BridgeRouteResult =
  | { status: number; payload: unknown }
  | { status: number; payload: unknown; invalidates: readonly BridgeInvalidateStore[] }

/** 写路由 handler 的入参（与 dispatchBridgeRequest 同形）。 */
interface WriteRouteContext {
  bridge: TradingBridge
  search: URLSearchParams
  body: unknown
  signal: AbortSignal | undefined
}

/**
 * 一条写路由声明：method + pathname + handler + **必填的 invalidates**。
 * 新增写端点却忘了声明失效 store 在这里是编译错误——本表是「写成功但客户端静默
 * 不刷新」的结构性防线（类型挡编译期，{@link resolveWriteRoute} 挡运行时）。
 * 交易台两个写端点显式声明空表：报单/撤单不改变任何客户端读面缓存（交易台自拉）。
 */
export interface BridgeWriteRoute {
  readonly method: 'PUT' | 'POST' | 'DELETE'
  readonly pathname: string
  readonly invalidates: readonly BridgeInvalidateStore[]
  handle(context: WriteRouteContext): Promise<{ status: number; payload: unknown }>
}

/** 全部非 GET 路由（同 (method, pathname) 只允许一条；顺序无关）。 */
export const BRIDGE_WRITE_ROUTES: readonly BridgeWriteRoute[] = [
  {
    method: 'DELETE',
    pathname: '/indicators/custom',
    invalidates: ['indicators'],
    handle: async ({ bridge, search }) => {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete custom indicator: id is required')
      return { status: 200, payload: await bridge.deleteCustomIndicator(id) }
    },
  },
  {
    method: 'DELETE',
    pathname: '/chart/indicators',
    invalidates: ['chart'],
    handle: async ({ bridge, search }) => {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete chart activation: id is required')
      return { status: 200, payload: await bridge.removeChartActivation(id) }
    },
  },
  {
    method: 'DELETE',
    pathname: '/strategies/custom',
    invalidates: ['strategies'],
    handle: async ({ bridge, search }) => {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete custom strategy: id is required')
      return { status: 200, payload: await bridge.deleteCustomStrategy(id) }
    },
  },
  {
    method: 'DELETE',
    pathname: '/strategies/screeners',
    invalidates: ['strategies'],
    handle: async ({ bridge, search }) => {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete screener: id is required')
      return { status: 200, payload: await bridge.deleteCustomScreener(id) }
    },
  },
  {
    method: 'DELETE',
    pathname: '/trade/order',
    invalidates: [],
    handle: async ({ bridge, search, signal }) => {
      const market = search.get('market') ?? ''
      const orderId = search.get('id') ?? search.get('orderId') ?? ''
      const symbol = search.get('symbol') ?? undefined
      if (!market) throw new BridgeProtocolError(400, 'cancel order: market is required')
      if (!orderId) throw new BridgeProtocolError(400, 'cancel order: id is required')
      return {
        status: 200,
        payload: await bridge.cancelOrderFromGui(market, orderId, symbol, {
          sessionId: search.get('sessionId') ?? undefined,
          intentId: search.get('intentId') ?? undefined,
          signal,
        }),
      }
    },
  },
  {
    method: 'DELETE',
    pathname: '/watchlists',
    invalidates: ['watchlists'],
    handle: async ({ bridge, search }) => {
      const market = search.get('market') ?? ''
      const symbol = search.get('symbol') ?? ''
      if (!market || !symbol) throw new BridgeProtocolError(400, 'delete watchlist row: market and symbol are required')
      return { status: 200, payload: await bridge.removeWatchlistRow(market, symbol) }
    },
  },
  {
    method: 'DELETE',
    pathname: '/watchlist-groups',
    invalidates: ['watchlists'],
    handle: async ({ bridge, search }) => {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete watchlist group: id is required')
      return { status: 200, payload: await bridge.removeWatchlistGroup(id) }
    },
  },
  {
    method: 'DELETE',
    pathname: '/watchlist-group-members',
    invalidates: ['watchlists'],
    handle: async ({ bridge, search }) => {
      const id = search.get('id') ?? ''
      const market = search.get('market') ?? ''
      const symbol = search.get('symbol') ?? ''
      if (!id || !market || !symbol) throw new BridgeProtocolError(400, 'remove group member: id, market and symbol are required')
      return { status: 200, payload: await bridge.removeWatchlistGroupMember(id, market, symbol) }
    },
  },
  {
    method: 'DELETE',
    pathname: '/holdings',
    invalidates: ['holdings'],
    handle: async ({ bridge, search }) => ({ status: 200, payload: await bridge.removeHolding(search.get('id') ?? '') }),
  },
  {
    method: 'PUT',
    pathname: '/watchlists',
    invalidates: ['watchlists'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.replaceWatchlists(body) }),
  },
  {
    method: 'PUT',
    pathname: '/watchlist-groups',
    invalidates: ['watchlists'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.renameWatchlistGroup(body) }),
  },
  {
    method: 'PUT',
    pathname: '/selection',
    invalidates: ['selection'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.putSelection(body) }),
  },
  {
    method: 'PUT',
    pathname: '/chart/indicators',
    invalidates: ['chart'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.putChartActivation(body) }),
  },
  {
    method: 'PUT',
    pathname: '/holdings',
    invalidates: ['holdings'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.updateHolding(body) }),
  },
  {
    method: 'PUT',
    pathname: '/strategies/custom',
    invalidates: ['strategies'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.saveCustomStrategy(body) }),
  },
  {
    method: 'PUT',
    pathname: '/strategies/screeners',
    invalidates: ['strategies'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.saveCustomScreener(body) }),
  },
  {
    method: 'POST',
    pathname: '/trade/order',
    invalidates: [],
    handle: async ({ bridge, search, body, signal }) =>
      ({ status: 200, payload: await bridge.placeOrderFromGui(search.get('market') ?? '', body as GuiOrderBody, signal) }),
  },
  {
    method: 'POST',
    pathname: '/strategies/reset',
    invalidates: ['strategies'],
    handle: async ({ bridge, body }) => {
      const input = (typeof body === 'object' && body !== null ? body : {}) as { id?: unknown }
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      if (!id) throw new BridgeProtocolError(400, 'reset strategy: id is required')
      return { status: 200, payload: await bridge.resetStrategy(id) }
    },
  },
  {
    method: 'POST',
    pathname: '/strategies/screeners/reset',
    invalidates: ['strategies'],
    handle: async ({ bridge, body }) => {
      const input = (typeof body === 'object' && body !== null ? body : {}) as { id?: unknown }
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      if (!id) throw new BridgeProtocolError(400, 'reset screener: id is required')
      return { status: 200, payload: await bridge.resetScreener(id) }
    },
  },
  {
    method: 'POST',
    pathname: '/watchlists',
    invalidates: ['watchlists'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.addWatchlistRow(body) }),
  },
  {
    method: 'POST',
    pathname: '/watchlists/import',
    invalidates: ['watchlists'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.importWatchlists(body) }),
  },
  {
    method: 'POST',
    pathname: '/watchlist-groups',
    invalidates: ['watchlists'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.createWatchlistGroup(body) }),
  },
  {
    method: 'POST',
    pathname: '/watchlist-group-members',
    invalidates: ['watchlists'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.addWatchlistGroupMember(body) }),
  },
  {
    method: 'POST',
    pathname: '/chart/indicators/import',
    invalidates: ['chart'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.importChartActivations(body) }),
  },
  {
    method: 'POST',
    pathname: '/holdings',
    invalidates: ['holdings'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.addHolding(body) }),
  },
  {
    method: 'POST',
    pathname: '/holdings/stage',
    invalidates: ['holdings'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.stageHoldings(body) }),
  },
  {
    method: 'POST',
    pathname: '/holdings/confirm',
    invalidates: ['holdings'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.confirmHoldings(body) }),
  },
  {
    method: 'POST',
    pathname: '/holdings/discard',
    invalidates: ['holdings'],
    handle: async ({ bridge, body }) => ({ status: 200, payload: await bridge.discardHoldings(body) }),
  },
]

/**
 * 写路由查表 + 失效声明守卫：未登记 → undefined（调用方回 404）；登记了却没有
 * invalidates → 抛错。运行时兜底挡住绕过类型声明的调用方——「新增写端点忘了声明
 * 失效 store」必须硬失败，不得退化成「写成功但客户端静默不刷新」。
 * routes 可注入，负向用例用一条未声明失效的路由验证守卫真的会拒绝。
 */
export function resolveWriteRoute(
  routes: readonly BridgeWriteRoute[],
  method: string,
  pathname: string,
): BridgeWriteRoute | undefined {
  const route = routes.find(item => item.method === method && item.pathname === pathname)
  if (route === undefined) return undefined
  if (!Array.isArray(route.invalidates)) {
    throw new Error(`write route ${method} ${pathname} is not declared with an invalidates list`)
  }
  return route
}

/**
 * 请求分发：把 (method, pathname, searchParams) 路由到桥方法，返回
 * (status, payload, invalidates)。非 GET 路由一律经 {@link BRIDGE_WRITE_ROUTES}
 * 声明表——失效 store 与路由写在同一处，index.ts 不再持有第二份 (method, path) 知识。
 * @param signal - HTTP 连接信号（GUI 实盘动作：客户端断连/超时 → 取消审批且不再报单）。
 */
export async function dispatchBridgeRequest(
  bridge: TradingBridge,
  method: string,
  pathname: string,
  search: URLSearchParams,
  body?: unknown,
  signal?: AbortSignal,
): Promise<BridgeRouteResult> {
  /** 读路由（GET）结果：不带 invalidates——读面不失效任何 store。 */
  const readResult = (payload: unknown): BridgeRouteResult => ({ status: 200, payload })
  if (method === 'GET') {
    switch (pathname) {
      case '/markets':
        return readResult(bridge.markets())
      case '/tickers': {
        const market = search.get('market') ?? ''
        const symbols = (search.get('symbols') ?? '').split(',')
        // provider 可选：空值/缺省 = 没指定源（维持 active 解析），非空值必须命中已注册项。
        const provider = search.get('provider')
        return readResult(await bridge.tickers(market, symbols, provider === null || provider === '' ? undefined : provider))
      }
      case '/klines': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        const interval = search.get('interval') ?? '1d'
        const limit = search.get('limit')
        return readResult(await bridge.klines(market, symbol, interval, limit))
      }
      case '/symbols': {
        const market = search.get('market') ?? ''
        const query = search.get('query') ?? undefined
        return readResult(await bridge.symbols(market, query))
      }
      case '/fundamentals': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return readResult(await bridge.fundamentals(market, symbol))
      }
      case '/active-buy': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return readResult(await bridge.activeBuy(market, symbol))
      }
      case '/southbound-holdings': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return readResult(await bridge.southboundHoldings(market, symbol))
      }
      case '/derivatives': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return readResult(await bridge.derivatives(market, symbol))
      }
      case '/derivatives/history': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return readResult(await bridge.derivativesHistory(market, symbol))
      }
      case '/orderbook': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return readResult(await bridge.orderbook(market, symbol))
      }
      case '/trades': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return readResult(await bridge.trades(market, symbol, search.get('limit')))
      }
      case '/trade/positions': {
        return readResult(await bridge.positions(search.get('market') ?? ''))
      }
      case '/trade/balances': {
        return readResult(await bridge.balances(search.get('market') ?? ''))
      }
      case '/trade/orders': {
        return readResult(await bridge.openOrders(search.get('market') ?? ''))
      }
      case '/trade/fills': {
        return readResult(await bridge.tradeFills(search.get('market') ?? ''))
      }
      case '/indicators/custom': {
        return readResult(await bridge.customIndicators())
      }
      case '/chart/indicators': {
        return readResult(await bridge.chartActivations())
      }
      case '/knowledge/cards': {
        return readResult(await bridge.knowledgeCards())
      }
      case '/holdings': {
        return readResult(await bridge.holdings())
      }
      case '/fx': {
        // base 缺省 USD；非法 base → 400 协议错误（契约 §4）。
        return readResult(await bridge.fx(search.get('base') ?? 'USD'))
      }
      case '/flash': {
        return readResult(await bridge.flash(search.get('cursor'), search.get('limit'), search.get('keyword'), search.get('hot')))
      }
      case '/macro/calendar': {
        return readResult(await bridge.macroCalendar(search.get('limit')))
      }
      case '/macro/rates': {
        return readResult(await bridge.macroRates())
      }
      case '/prediction/fomc': {
        return readResult(await bridge.predictionFomc())
      }
      case '/news': {
        const market = search.get('market') ?? ''
        if (!market) throw new BridgeProtocolError(400, 'news: market is required')
        return readResult(await bridge.news(market, search.get('symbol'), search.get('limit')))
      }
      case '/strategies/custom': {
        return readResult(await bridge.customStrategies())
      }
      case '/strategies/tombstones': {
        return readResult(await bridge.builtinTombstones())
      }
      case '/strategies/screeners': {
        return readResult(await bridge.customScreeners())
      }
      case '/watchlists': {
        return readResult(await bridge.watchlistRows())
      }
      case '/watchlist-groups': {
        return readResult(await bridge.watchlistGroups())
      }
      case '/selection': {
        return readResult(await bridge.selection())
      }
      default:
        throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
    }
  }

  if (method !== 'PUT' && method !== 'POST' && method !== 'DELETE') {
    throw new BridgeProtocolError(405, 'only GET/PUT/POST/DELETE are supported')
  }
  const route = resolveWriteRoute(BRIDGE_WRITE_ROUTES, method, pathname)
  if (route === undefined) throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  const result = await route.handle({ bridge, search, body, signal })
  return { status: result.status, payload: result.payload, invalidates: route.invalidates }
}
