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
import type { Interval, Kline, MarketDataService, StockFundamentals, Ticker } from '@dsh-trading/api'
import type { CustomIndicatorRecord, CustomIndicatorStore } from '@dsh-trading/indicators'
import { createMemoryCustomIndicatorStore } from '@dsh-trading/indicators'
import type { KnowledgeCard, KnowledgeCardStore } from '@dsh-trading/knowledge'
import { createMemoryKnowledgeCardStore } from '@dsh-trading/knowledge'
import type { CustomStrategyRecord, CustomStrategyStore } from '@dsh-trading/strategies'
import { createMemoryCustomStrategyStore } from '@dsh-trading/strategies'
import type { SelectionStore, WatchlistInstrument, WatchlistStore, WatchlistsMap } from '@dsh-trading/watchlist'
import { createMemorySelectionStore, createMemoryWatchlistStore } from '@dsh-trading/watchlist'

/** 本桥支持的市场（与连接器服务键一一对应）。 */
export type MarketId = 'crypto' | 'us' | 'cn' | 'hk'

export const MARKET_IDS: readonly MarketId[] = ['crypto', 'us', 'cn', 'hk']

/** market → Context 服务键（@dsh-trading/api 的 Context 增强）。 */
export const MARKET_SERVICE_KEYS: Record<MarketId, string> = {
  crypto: 'tradingCryptoMarketData',
  us: 'tradingUsMarketData',
  cn: 'tradingCnMarketData',
  hk: 'tradingHkMarketData',
}

/** 注册表服务的最小形状（鸭式，与 @dsh-trading/router 的 MarketDataRegistryLike 同构）。 */
export interface MarketDataRegistryLike {
  active(market: string): { provider: string; service: MarketDataService } | undefined
}

/**
 * 桥宿主工厂（registry-first 解析的唯一实现，node 半与单测共用）：
 * - getMarketService：注册表有激活注册项 → 用之；否则回退 legacy 市场键直读
 *   （2026-08-30 前形态：连接器老 dataplane 互斥 provide 市场键的部署）。
 * - activeProvider：优先报告实际供数的注册项 provider；注册表未裁决时回退 router 值
 *   （选中但未注册 → 用户能在 GUI 看到设置目标，行情区报「未安装/未激活」）。
 */
export function createBridgeHost(services: {
  registry?: MarketDataRegistryLike
  router?: { activeProvider(market: string): string | undefined }
  legacy(market: MarketId): MarketDataService | undefined
  customIndicatorsStore?: CustomIndicatorStore
  knowledgeStore?: KnowledgeCardStore
  strategyStore?: CustomStrategyStore
  watchlistStore?: WatchlistStore
  selectionStore?: SelectionStore
}): BridgeHost {
  return {
    getMarketService: market => {
      const active = services.registry?.active(market)
      if (active !== undefined) return active.service
      return services.legacy(market)
    },
    activeProvider: market => services.registry?.active(market)?.provider ?? services.router?.activeProvider(market),
    customIndicatorsStore: services.customIndicatorsStore ?? createMemoryCustomIndicatorStore(),
    knowledgeStore: services.knowledgeStore ?? createMemoryKnowledgeCardStore(),
    strategyStore: services.strategyStore ?? createMemoryCustomStrategyStore(),
    watchlistStore: services.watchlistStore ?? createMemoryWatchlistStore(),
    selectionStore: services.selectionStore ?? createMemorySelectionStore(),
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
  /** 知识卡片存储（可选）。 */
  knowledgeStore?: KnowledgeCardStore
  /** 自定义策略存储（可选，issue #31）。 */
  strategyStore?: CustomStrategyStore
  /** 自选股存储（可选，issue #32）。 */
  watchlistStore?: WatchlistStore
  /** 选中标的存储（可选，issue #32）。 */
  selectionStore?: SelectionStore
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

export interface CustomIndicatorsWire {
  ok: true
  indicators: CustomIndicatorRecord[]
}

export interface KnowledgeCardsWire {
  ok: true
  cards: readonly KnowledgeCard[]
}

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

/** 从 Error 上提取结构化错误词汇（连接器按 TradingError 形状附加 code）。 */
export function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'TRADING_UNKNOWN'
    return { code, message: error.message }
  }
  return { code: 'TRADING_UNKNOWN', message: String(error) }
}

export class TradingBridge {
  private readonly symbolsCache = new Map<string, { list: SymbolInfoWire[]; fetchedAt: number }>()

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
  async symbols(market: string): Promise<SymbolsWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    const cached = this.symbolsCache.get(market)
    if (cached !== undefined && Date.now() - cached.fetchedAt < SYMBOLS_CACHE_TTL_MS) {
      return { symbols: cached.list }
    }
    if (typeof service.listInstruments !== 'function') {
      return { symbols: [] }
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
   * 标的基本面快照（GUI「基本面」页签，2026-09-02）：单 symbol 透传注册表解析出的
   * 行情服务。连接器未实现可选 getFundamentals（us/crypto 数据源不携带基本面字段）
   * → 业务错误 TRADING_NOT_IMPLEMENTED（HTTP 200 + ok:false），前端降级为派生数据。
   */
  async fundamentals(market: string, symbol: string): Promise<FundamentalsWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'fundamentals: symbol is required')
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    if (typeof service.getFundamentals !== 'function') {
      throw Object.assign(
        new Error(`market ${market} provider does not implement fundamentals — derived data only`),
        { code: 'TRADING_NOT_IMPLEMENTED' },
      )
    }
    return { ok: true, fundamentals: await service.getFundamentals(trimmed) }
  }

  /** 自定义指标列表。 */
  async customIndicators(): Promise<CustomIndicatorsWire> {    const store = this.host.customIndicatorsStore
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
        return { status: 200, payload: await bridge.symbols(market) }
      }
      case '/fundamentals': {
        const market = search.get('market') ?? ''
        const symbol = search.get('symbol') ?? ''
        return { status: 200, payload: await bridge.fundamentals(market, symbol) }
      }
      case '/indicators/custom': {
        return { status: 200, payload: await bridge.customIndicators() }
      }
      case '/knowledge/cards': {
        return { status: 200, payload: await bridge.knowledgeCards() }
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
    if (pathname === '/strategies/custom') {
      const id = search.get('id') ?? ''
      if (!id) throw new BridgeProtocolError(400, 'delete custom strategy: id is required')
      return { status: 200, payload: await bridge.deleteCustomStrategy(id) }
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
    throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  }

  if (method === 'POST') {
    if (pathname === '/watchlists') {
      return { status: 200, payload: await bridge.addWatchlistRow(body) }
    }
    if (pathname === '/watchlists/import') {
      return { status: 200, payload: await bridge.importWatchlists(body) }
    }
    throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  }

  throw new BridgeProtocolError(405, 'only GET/PUT/POST/DELETE are supported')
}
