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
 */
import type { AccountBalance, DerivativesData, DerivativesHistory, FundamentalsPackage, Interval, Kline, MarketDataService, NewsAggregator, NewsItem, Order, Orderbook, Position, StockFundamentals, Ticker, TradeFill, TradeService, TradeTick } from '@dshtrading/api'
import { aggregateNews as aggregateCnNews, fetchCnFundamentalsPackage } from '@dshtrading/kit-cn'
import { aggregateNews as aggregateHkNews, fetchHkFundamentalsPackage } from '@dshtrading/kit-hk'
import { aggregateNews as aggregateUsNews, fetchUsFundamentalsPackage } from '@dshtrading/kit-us'
import { aggregateNews as aggregateCryptoNews, fetchCryptoFundamentalsPackage } from '@dshtrading/kit-crypto'
import type { ChartActivationStore, CustomIndicatorRecord, CustomIndicatorStore, IndicatorInstance } from '@dshtrading/indicators'
import { clampActivationParams, createMemoryChartActivationStore, createMemoryCustomIndicatorStore, resolveIndicatorSpec } from '@dshtrading/indicators'
import type { KnowledgeCard, KnowledgeCardStore } from '@dshtrading/knowledge'
import { createMemoryKnowledgeCardStore } from '@dshtrading/knowledge'
import type { CustomStrategyRecord, CustomStrategyStore } from '@dshtrading/strategies'
import { createMemoryCustomStrategyStore } from '@dshtrading/strategies'
import type { SelectionStore, WatchlistInstrument, WatchlistStore, WatchlistsMap } from '@dshtrading/watchlist'
import { createMemorySelectionStore, createMemoryWatchlistStore } from '@dshtrading/watchlist'

/** 本桥支持的市场（与连接器服务键一一对应）。 */
export type MarketId = 'crypto' | 'us' | 'cn' | 'hk'

export const MARKET_IDS: readonly MarketId[] = ['crypto', 'us', 'cn', 'hk']

/** market → Context 服务键（@dshtrading/api 的 Context 增强）。 */
export const MARKET_SERVICE_KEYS: Record<MarketId, string> = {
  crypto: 'tradingCryptoMarketData',
  us: 'tradingUsMarketData',
  cn: 'tradingCnMarketData',
  hk: 'tradingHkMarketData',
}

/** 注册表服务的最小形状（鸭式，与 @dshtrading/router 的 MarketDataRegistryLike 同构）。 */
export interface MarketDataRegistryLike {
  active(market: string): { provider: string; service: MarketDataService } | undefined
}

/** 交易注册表服务的最小形状（issue #40，鸭式；api 包 TradeRegistry 同构）。 */
export interface TradeRegistryLike {
  active(market: string): { provider: string; service: TradeService } | undefined
}

/** 新闻注册表服务的最小形状（issue #37，鸭式；api 包 TradingNewsRegistry 同构）。 */
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
  watchlistStore?: WatchlistStore | undefined
  selectionStore?: SelectionStore | undefined
  /** 新闻注册表（issue #37）。 */
  newsRegistry?: TradingNewsRegistryLike | undefined
  /** CryptoPanic API token 取值函数（从 router settings 获取；可选）。 */
  newsKey?: (() => string | undefined) | undefined
}): BridgeHost {
  return {
    getMarketService: market => {
      const active = services.registry?.active(market)
      if (active !== undefined) return active.service
      return services.legacy(market)
    },
    getTradeService: market => services.tradeRegistry?.active(market)?.service,
    activeProvider: market => services.registry?.active(market)?.provider ?? services.router?.activeProvider(market),
    customIndicatorsStore: services.customIndicatorsStore ?? createMemoryCustomIndicatorStore(),
    chartActivationsStore: services.chartActivationsStore ?? createMemoryChartActivationStore(),
    knowledgeStore: services.knowledgeStore ?? createMemoryKnowledgeCardStore(),
    strategyStore: services.strategyStore ?? createMemoryCustomStrategyStore(),
    watchlistStore: services.watchlistStore ?? createMemoryWatchlistStore(),
    selectionStore: services.selectionStore ?? createMemorySelectionStore(),
    newsRegistry: services.newsRegistry,
    newsKey: services.newsKey,
  }
}

/** 单次批量报价的 symbols 封顶（保护公共端点，超出部分直接拒绝）。 */
export const MAX_SYMBOLS = 32

/** 单次 K 线 limit 封顶（与 Binance/Bybit 单请求上限对齐；OKX 超出 300 的部分由连接器 after 游标翻页补足）。 */
export const MAX_KLINE_LIMIT = 1000

/** 宿主面：桥对 cordis ctx 的最小依赖（便于单测注入假件）。 */
export interface BridgeHost {
  /** 取市场行情服务；未安装/未激活返回 undefined。 */
  getMarketService(market: MarketId): MarketDataService | undefined
  /** 该市场当前激活的 provider slug（router 设置；可能 undefined）。 */
  activeProvider(market: MarketId): string | undefined
  /** 自定义指标存储（可选）。 */
  customIndicatorsStore?: CustomIndicatorStore
  /** 图表激活名册存储（可选，issue #63）。 */
  chartActivationsStore?: ChartActivationStore
  /** 知识卡片存储（可选）。 */
  knowledgeStore?: KnowledgeCardStore
  /** 自定义策略存储（可选，issue #31）。 */
  strategyStore?: CustomStrategyStore
  /** 自选股存储（可选，issue #32）。 */
  watchlistStore?: WatchlistStore
  /** 选中标的存储（可选，issue #32）。 */
  selectionStore?: SelectionStore
  /**
   * 交易服务（可选，issue #40）：tradeRegistry 按 market 解析；未注册 → undefined
   * （交易台整体隐藏）。**安全语义**：桥只放行 dry-run 下单与只读查询——
   * placeOrder 的 dryRun 被强制为 true，实盘路径不经 GUI。
   */
  getTradeService?(market: MarketId): TradeService | undefined
  /** 新闻注册表（可选，issue #37）：各市场 Kit 注册的新闻聚合器。 */
  newsRegistry?: TradingNewsRegistryLike | undefined
  /** CryptoPanic API token 取值函数（从 router settings 获取；可选，issue #37）。 */
  newsKey?: (() => string | undefined) | undefined
}

export interface MarketInfoWire {
  id: MarketId
  provider?: string
}

export type TickerOutcome =
  | { ok: true; ticker: Ticker }
  | { ok: false; code: string; message: string }

export interface MarketsWire {
  markets: MarketInfoWire[]
}

export interface TickersWire {
  tickers: Record<string, TickerOutcome>
}

export interface KlinesWire {
  klines: Kline[]
}

export interface SymbolInfoWire {
  symbol: string
  name?: string
}

export interface SymbolsWire {
  symbols: SymbolInfoWire[]
}

export interface FundamentalsWire {
  ok: true
  fundamentals: StockFundamentals
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
  code: 'TRADING_UNKNOWN_INDICATOR'
  message: string
}

export interface KnowledgeCardsWire {
  ok: true
  cards: readonly KnowledgeCard[]
}

/* -- 新闻 wire（issue #37）----------------------------------------------- */

export interface NewsWire {
  ok: true
  items: readonly NewsItem[]
  unavailable: readonly string[]
}

/** 新闻端点条目上限（保护公共数据源；超出部分由 Kit 层截流）。 */
export const MAX_NEWS_LIMIT = 50

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

/** 动态标的全集缓存 TTL（30分钟）。 */
export const SYMBOLS_CACHE_TTL_MS = 30 * 60 * 1000

/**
 * 基本面数据包缓存 TTL（5分钟）：财报级/日级数据，非 tick；同键 in-flight 去重
 * 让 tab 翻转与快速切标的只打一轮上游（issue #36 整改，2026-09-02）。
 */
export const FUNDAMENTALS_CACHE_TTL_MS = 5 * 60 * 1000

/** 从 Error 上提取结构化错误词汇（连接器按 TradingError 形状附加 code）。 */
export function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const raw = (error as { code?: unknown }).code
    const code = typeof raw === 'string' ? raw : 'TRADING_UNKNOWN'
    return { code, message: error.message }
  }
  return { code: 'TRADING_UNKNOWN', message: String(error) }
}

export class TradingBridge {
  private readonly symbolsCache = new Map<string, { list: SymbolInfoWire[]; fetchedAt: number }>()
  private readonly fundamentalsCache = new Map<string, { pkg: StockFundamentals; fetchedAt: number }>()
  private readonly fundamentalsInflight = new Map<string, Promise<StockFundamentals>>()

  constructor(private readonly host: BridgeHost) {}

  /** 已安装（有行情服务）的市场清单 + 当前 provider slug。 */
  markets(): MarketsWire {
    const markets: MarketInfoWire[] = []
    for (const id of MARKET_IDS) {
      if (this.host.getMarketService(id) === undefined) continue
      const provider = this.host.activeProvider(id)
      markets.push(provider === undefined ? { id } : { id, provider })
    }
    return { markets }
  }

  /** 批量报价：逐 symbol 独立成功/失败（一个坏代码不拖垮整批）。 */
  async tickers(market: string, symbols: string[]): Promise<TickersWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const unique = [...new Set(symbols.map(symbol => symbol.trim()).filter(Boolean))]
    if (unique.length === 0) throw new BridgeProtocolError(400, 'tickers: symbols is required')
    if (unique.length > MAX_SYMBOLS) {
      throw new BridgeProtocolError(400, `tickers: too many symbols (${unique.length} > ${MAX_SYMBOLS})`)
    }
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    const outcomes = await Promise.all(unique.map(async (symbol): Promise<TickerOutcome> => {
      try {
        return { ok: true, ticker: await service.getTicker(symbol) }
      } catch (error) {
        return { ok: false, ...errorPayload(error) }
      }
    }))
    const tickers: Record<string, TickerOutcome> = {}
    unique.forEach((symbol, index) => { tickers[symbol] = outcomes[index] as TickerOutcome })
    return { tickers }
  }

  /** K 线：透传 interval（连接器自行校验各自支持集）。 */
  async klines(market: string, symbol: string, interval: string, rawLimit: string | null): Promise<KlinesWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'klines: symbol is required')
    const limit = rawLimit === null || rawLimit === undefined ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_KLINE_LIMIT)) {
      throw new BridgeProtocolError(400, `klines: limit must be an integer in 1..${MAX_KLINE_LIMIT}`)
    }
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    const klines = await service.getKlines(trimmed, interval as Interval, limit)
    return { klines }
  }

  /** 动态标的全集（带 30min 进程内缓存；未实现或异常静默回落空列表）。 */
  async symbols(market: string, query?: string): Promise<SymbolsWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    if (typeof service.listInstruments !== 'function') {
      return { symbols: [] }
    }
    const trimmed = query?.trim().toLowerCase()
    if (trimmed) {
      try {
        const list = await (service as unknown as { listInstruments(q?: string): Promise<Array<{ symbol: string; name?: string }>> }).listInstruments(trimmed)
        let symbols: SymbolInfoWire[] = Array.isArray(list)
          ? list.map(item => ({ symbol: item.symbol, ...(item.name ? { name: item.name } : {}) }))
          : []
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
    const cached = this.symbolsCache.get(market)
    if (cached !== undefined && Date.now() - cached.fetchedAt < SYMBOLS_CACHE_TTL_MS) {
      return { symbols: cached.list }
    }
    try {
      const list = await service.listInstruments()
      const symbols: SymbolInfoWire[] = Array.isArray(list)
        ? list.map(item => ({ symbol: item.symbol, ...(item.name ? { name: item.name } : {}) }))
        : []
      this.symbolsCache.set(market, { list: symbols, fetchedAt: Date.now() })
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
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'derivatives: symbol is required')
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
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
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'derivatives history: symbol is required')
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
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
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'orderbook: symbol is required')
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
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
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'trades: symbol is required')
    const limit = rawLimit === null || rawLimit === undefined ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_TRADES_LIMIT)) {
      throw new BridgeProtocolError(400, `trades: limit must be an integer in 1..${MAX_TRADES_LIMIT}`)
    }
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
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
   * GUI 下单（真交易执行）：支持实盘报单（默认 dryRun: false）。
   * 若底层连接器未配置 API 凭证或未开启 liveTrading，由服务缝闸门抛出标准错误，
   * 桥层如实向前端返回，杜绝伪造假成交。
   */
  async placeOrderFromGui(market: string, body: GuiOrderBody): Promise<PlaceOrderWire> {
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
    const order = await trade.placeOrder({
      symbol,
      side,
      type,
      quantity,
      ...(price !== undefined ? { price } : {}),
      dryRun: requestedDryRun,
    })
    return { ok: true, order }
  }

  /** GUI 撤单（issue #40）：按 market + orderId + 可选 symbol 分发到激活的交易服务。 */
  async cancelOrderFromGui(market: string, orderId: string, symbol?: string): Promise<{ ok: true; canceled: boolean }> {
    const trade = this.#requireTradeService(market)
    const trimmedId = orderId.trim()
    if (!trimmedId) throw new BridgeProtocolError(400, 'cancel order: id is required')
    await trade.cancelOrder(trimmedId, symbol?.trim())
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

  /**
   * 标的新闻与公告聚合（issue #37）：按市场从 newsRegistry 解析到 Kit 注册的
   * 聚合器；未注册时回退到各 Kit 导出的 aggregateNews 纯函数（无活跃会话时亦可用）。
   * 只返回与标的相关的条目（2026-09-03 owner 裁决）：无相关新闻/公告就返回空列表，
   * 不再回退展示大盘要闻——此前的智能回退会把已抓到的公告挤出 limit 截尾窗。
   */
  async news(market: string, symbol: string | null, rawLimit: string | null): Promise<NewsWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const aggregator = this.host.newsRegistry?.get(market)
      ?? (market === 'cn' ? aggregateCnNews
        : market === 'hk' ? aggregateHkNews
        : market === 'us' ? aggregateUsNews
        : market === 'crypto' ? aggregateCryptoNews
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
    })

    return { ok: true, items: result.items, unavailable: result.unavailable }
  }

  /** 自定义策略名册（issue #31）：返回记录，前端校验后并入名册。 */
  async customStrategies(): Promise<{ ok: boolean; strategies: CustomStrategyRecord[] }> {
    const store = this.host.strategyStore
    if (store === undefined) return { ok: true, strategies: [] }
    const strategies = await store.list()
    return { ok: true, strategies }
  }

  /** 删除自定义策略（issue #31）。 */
  async deleteCustomStrategy(id: string): Promise<{ ok: boolean; removed: boolean }> {
    const store = this.host.strategyStore
    if (store === undefined) return { ok: true, removed: false }
    const removed = await store.remove(id)
    return { ok: true, removed }
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
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'fundamentals: symbol is required')
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)

    const cacheKey = `${market}:${trimmed}`
    const cached = this.fundamentalsCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.fetchedAt < FUNDAMENTALS_CACHE_TTL_MS) {
      return { ok: true, fundamentals: cached.pkg }
    }
    const inflight = this.fundamentalsInflight.get(cacheKey)
    if (inflight !== undefined) return { ok: true, fundamentals: await inflight }

    const job = (async (): Promise<StockFundamentals> => {
      const [snapshot, pkg] = await Promise.all([
        typeof service.getFundamentals === 'function'
          ? service.getFundamentals(trimmed).catch(() => undefined)
          : Promise.resolve(undefined),
        this.#fetchPkg(market, trimmed),
      ])
      if (snapshot === undefined && pkg === undefined) {
        throw Object.assign(
          new Error(`no fundamentals data for ${market}/${trimmed} — provider and drill-down both unavailable`),
          { code: 'TRADING_NOT_IMPLEMENTED' },
        )
      }
      // 合并语义：pkg 是骨架（含 market/symbol），snapshot 只增强 stock 字段；
      // 只有快照没有 pkg 时，快照自身就是返回值（含 timestamp，满足契约必填）。
      const result: StockFundamentals = pkg !== undefined
        ? ({
            ...pkg,
            stock: { ...(pkg.stock ?? {}), ...(snapshot ?? {}) },
            timestamp: snapshot?.timestamp ?? Date.now(),
          } as unknown as StockFundamentals)
        : snapshot as StockFundamentals
      this.fundamentalsCache.set(cacheKey, { pkg: result, fetchedAt: Date.now() })
      return result
    })()

    this.fundamentalsInflight.set(cacheKey, job)
    try {
      const result = await job
      return { ok: true, fundamentals: result }
    } finally {
      this.fundamentalsInflight.delete(cacheKey)
    }
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
    const map = parseWatchlistsMap(body)
    await store.save(map)
    return { ok: true, watchlists: await store.list() }
  }

  /** 追加一行（POST /watchlists）。 */
  async addWatchlistRow(body: unknown): Promise<{ ok: boolean; added: boolean; instrument: WatchlistInstrument }> {
    const store = this.host.watchlistStore
    if (store === undefined) {
      const instrument = parseInstrumentBody(body)
      return { ok: true, added: false, instrument }
    }
    const instrument = parseInstrumentBody(body)
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
    const existingRows = Object.values(existing).reduce((sum, rows) => sum + (rows?.length ?? 0), 0)
    if (existingRows > 0) {
      return { ok: false, imported: false, reason: 'host watchlist store is not empty — migration already done (idempotent guard)' }
    }
    const map = parseWatchlistsMap(body)
    await store.save(map)
    return { ok: true, imported: true }
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
   * 挂载/更新一个激活实例（PUT /chart/indicators，body { id, params? }）：
   * id 必须能解析为预置或自定义指标（未知 id 业务拒绝——与 GUI 可渲染集合同源）；
   * params 按 schema clamp，缺失键取 schema 默认值。
   */
  async putChartActivation(body: unknown): Promise<ChartActivationsWire | ChartActivationRejectedWire> {
    const store = this.host.chartActivationsStore
    const raw = (body ?? {}) as { id?: unknown; params?: unknown }
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
    const instance: IndicatorInstance = { id, params }
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
    const parsed = body as { instrument?: WatchlistInstrument | null } | undefined
    const instrument = parsed?.instrument === undefined || parsed.instrument === null
      ? null
      : {
        market: String(parsed.instrument.market ?? ''),
        symbol: String(parsed.instrument.symbol ?? ''),
        ...(parsed.instrument.name !== undefined ? { name: String(parsed.instrument.name) } : {}),
      }
    if (store === undefined) return { ok: true, instrument }
    await store.set({ instrument })
    return { ok: true, instrument }
  }
}

/** 自选 map 的形状校验（Record<market, Instrument[]>，宽容 name 缺省）。 */
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
      const r = row as { market?: unknown; symbol?: unknown; name?: unknown }
      if (typeof r?.symbol !== 'string' || !r.symbol) {
        throw new BridgeProtocolError(400, `watchlists[${market}] rows must have string symbol`)
      }
      return {
        market: typeof r.market === 'string' ? r.market : market,
        symbol: r.symbol,
        ...(typeof r.name === 'string' && r.name ? { name: r.name } : {}),
      }
    })
  }
  return out
}

/** 单行 instrument 的形状校验。 */
function parseInstrumentBody(body: unknown): WatchlistInstrument {
  const raw = (body ?? {}) as { market?: unknown; symbol?: unknown; name?: unknown }
  const market = typeof raw.market === 'string' ? raw.market.trim() : ''
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
  if (!market || !symbol) {
    throw new BridgeProtocolError(400, 'instrument body requires string market and symbol')
  }
  return {
    market,
    symbol,
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
  }
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
    out.push({ id, params: clean })
  }
  return out
}

/** 请求分发：把 (method, pathname, searchParams) 路由到桥方法，返回 (status, payload)。 */
export async function dispatchBridgeRequest(
  bridge: TradingBridge,
  method: string,
  pathname: string,
  search: URLSearchParams,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  if (method === 'GET') {
    switch (pathname) {
      case '/markets':
        return { status: 200, payload: bridge.markets() }
      case '/tickers': {
        const market = search.get('market') ?? ''
        const symbols = (search.get('symbols') ?? '').split(',')
        return { status: 200, payload: await bridge.tickers(market, symbols) }
      }
      case '/klines': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        const interval = search.get('interval') ?? '1d'
        const limit = search.get('limit')
        return { status: 200, payload: await bridge.klines(market, symbol, interval, limit) }
      }
      case '/symbols': {
        const market = search.get('market') ?? ''
        const query = search.get('query') ?? undefined
        return { status: 200, payload: await bridge.symbols(market, query) }
      }
      case '/fundamentals': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return { status: 200, payload: await bridge.fundamentals(market, symbol) }
      }
      case '/derivatives': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return { status: 200, payload: await bridge.derivatives(market, symbol) }
      }
      case '/derivatives/history': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return { status: 200, payload: await bridge.derivativesHistory(market, symbol) }
      }
      case '/orderbook': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return { status: 200, payload: await bridge.orderbook(market, symbol) }
      }
      case '/trades': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return { status: 200, payload: await bridge.trades(market, symbol, search.get('limit')) }
      }
      case '/trade/positions': {
        return { status: 200, payload: await bridge.positions(search.get('market') ?? '') }
      }
      case '/trade/balances': {
        return { status: 200, payload: await bridge.balances(search.get('market') ?? '') }
      }
      case '/trade/orders': {
        return { status: 200, payload: await bridge.openOrders(search.get('market') ?? '') }
      }
      case '/trade/fills': {
        return { status: 200, payload: await bridge.tradeFills(search.get('market') ?? '') }
      }
      case '/indicators/custom': {
        return { status: 200, payload: await bridge.customIndicators() }
      }
      case '/chart/indicators': {
        return { status: 200, payload: await bridge.chartActivations() }
      }
      case '/knowledge/cards': {
        return { status: 200, payload: await bridge.knowledgeCards() }
      }
      case '/news': {
        const market = search.get('market') ?? ''
        if (!market) throw new BridgeProtocolError(400, 'news: market is required')
        return { status: 200, payload: await bridge.news(market, search.get('symbol'), search.get('limit')) }
      }
      case '/strategies/custom': {
        return { status: 200, payload: await bridge.customStrategies() }
      }
      case '/watchlists': {
        return { status: 200, payload: await bridge.watchlistRows() }
      }
      case '/selection': {
        return { status: 200, payload: await bridge.selection() }
      }
      default:
        throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
    }
  }

  if (method === 'DELETE') {
    if (pathname === '/indicators/custom') {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete custom indicator: id is required')
      return { status: 200, payload: await bridge.deleteCustomIndicator(id) }
    }
    if (pathname === '/chart/indicators') {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete chart activation: id is required')
      return { status: 200, payload: await bridge.removeChartActivation(id) }
    }
    if (pathname === '/strategies/custom') {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete custom strategy: id is required')
      return { status: 200, payload: await bridge.deleteCustomStrategy(id) }
    }
    if (pathname === '/trade/order') {
      const market = search.get('market') ?? ''
      const orderId = search.get('id') ?? search.get('orderId') ?? ''
      const symbol = search.get('symbol') ?? undefined
      if (!market) throw new BridgeProtocolError(400, 'cancel order: market is required')
      if (!orderId) throw new BridgeProtocolError(400, 'cancel order: id is required')
      return { status: 200, payload: await bridge.cancelOrderFromGui(market, orderId, symbol) }
    }
    if (pathname === '/watchlists') {
      const market = search.get('market') ?? ''
      const symbol = search.get('symbol') ?? ''
      if (!market || !symbol) throw new BridgeProtocolError(400, 'delete watchlist row: market and symbol are required')
      return { status: 200, payload: await bridge.removeWatchlistRow(market, symbol) }
    }
    throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  }

  if (method === 'PUT') {
    if (pathname === '/watchlists') {
      return { status: 200, payload: await bridge.replaceWatchlists(body) }
    }
    if (pathname === '/selection') {
      return { status: 200, payload: await bridge.putSelection(body) }
    }
    if (pathname === '/chart/indicators') {
      return { status: 200, payload: await bridge.putChartActivation(body) }
    }
    throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  }

  if (method === 'POST') {
    if (pathname === '/trade/order') {
      return { status: 200, payload: await bridge.placeOrderFromGui(search.get('market') ?? '', body as GuiOrderBody) }
    }
    if (pathname === '/watchlists') {
      return { status: 200, payload: await bridge.addWatchlistRow(body) }
    }
    if (pathname === '/watchlists/import') {
      return { status: 200, payload: await bridge.importWatchlists(body) }
    }
    if (pathname === '/chart/indicators/import') {
      return { status: 200, payload: await bridge.importChartActivations(body) }
    }
    throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  }

  throw new BridgeProtocolError(405, 'only GET/PUT/POST/DELETE are supported')
}
