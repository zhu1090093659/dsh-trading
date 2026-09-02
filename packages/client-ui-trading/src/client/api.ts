/**
 * Bridge client: same-origin fetch wrappers over /dshtrading/api (the node
 * half registers the route behind the browser-auth fence; same-origin fetch
 * carries the auth cookie by default).
 */
import type { DerivativesData, Kline, MarketId, MarketInfo, Orderbook, StockFundamentals, TickerOutcome, TradeTick } from './types.ts'
import type { CustomIndicatorRecord } from '@dsh-trading/indicators'
import type { KnowledgeCard } from '@dsh-trading/knowledge'
import type { CustomStrategyRecord } from '@dsh-trading/strategies'

export class BridgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (response.status === 401) throw new BridgeError(401, 'unauthorized')
  if (response.status === 403) throw new BridgeError(403, 'forbidden')
  if (!response.ok) throw new BridgeError(response.status, `bridge ${path} failed: ${response.status}`)
  const wire = await response.json() as T
  // 桥的业务错误信封是 HTTP 200 + { ok:false, code, message }；必须转成 rejection，
  // 否则调用方拿到 undefined 当成功值（会以 .map-of-undefined 之类的次生错误炸开）。
  if (wire !== null && typeof wire === 'object' && (wire as { ok?: unknown }).ok === false) {
    const business = wire as { code?: string; message?: string }
    throw new BridgeError(200, `${business.code ?? 'TRADING_UNKNOWN'}: ${business.message ?? 'bridge business error'}`)
  }
  return wire
}

/** Installed markets + active provider slugs (drives the sidebar tab strip). */
export async function fetchMarkets(): Promise<MarketInfo[]> {
  const wire = await getJson<{ markets: MarketInfo[] }>('/dshtrading/api/markets')
  return wire.markets ?? []
}

/** Batched tickers; per-symbol outcomes are independent (bad codes don't sink the batch). */
export async function fetchTickers(market: MarketId, symbols: string[]): Promise<Record<string, TickerOutcome>> {
  const query = new URLSearchParams({ market, symbols: symbols.join(',') })
  const wire = await getJson<{ tickers: Record<string, TickerOutcome> }>(`/dshtrading/api/tickers?${query.toString()}`)
  return wire.tickers ?? {}
}

export async function fetchKlines(market: MarketId, symbol: string, interval: string, limit: number): Promise<Kline[]> {
  const query = new URLSearchParams({ market, symbol, interval, limit: String(limit) })
  const wire = await getJson<{ klines: Kline[] }>(`/dshtrading/api/klines?${query.toString()}`)
  return Array.isArray(wire.klines) ? wire.klines : []
}

/**
 * 基本面快照（2026-09-02 基本面页签）。连接器未实现 getFundamentals（us/crypto）
 * 或取数失败 → null：面板降级为行情派生数据（日K 52 周高低），不报错横幅。
 */
export async function fetchFundamentals(market: MarketId, symbol: string): Promise<StockFundamentals | null> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; fundamentals: StockFundamentals }>(`/dshtrading/api/fundamentals?${query.toString()}`)
    return wire.fundamentals ?? null
  } catch {
    return null
  }
}

/**
 * 衍生品指标快照（issue #38，crypto 专属）。连接器未实现 getDerivatives（现货/股票
 * 数据源）或取数失败 → null：面板整体隐藏，不报错横幅。
 */
export async function fetchDerivatives(market: MarketId, symbol: string): Promise<DerivativesData | null> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; derivatives: DerivativesData }>(`/dshtrading/api/derivatives?${query.toString()}`)
    return wire.derivatives ?? null
  } catch {
    return null
  }
}

/**
 * 盘口快照（issue #39）。连接器未实现 getOrderbook（yahoo/stooq/腾讯 r_hk）或
 * 取数失败 → null：竖栏降级为「未提供盘口」提示，不报错横幅。
 */
export async function fetchOrderbook(market: MarketId, symbol: string): Promise<Orderbook | null> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; orderbook: Orderbook }>(`/dshtrading/api/orderbook?${query.toString()}`)
    return wire.orderbook ?? null
  } catch {
    return null
  }
}

/**
 * 最近逐笔成交（issue #39，时间升序）。连接器未实现 getRecentTrades 或失败 → null：
 * 流水段隐藏；成功但空数组 → []（展示空态由调用方判断 length）。
 */
export async function fetchRecentTrades(market: MarketId, symbol: string, limit = 50): Promise<TradeTick[] | null> {
  try {
    const query = new URLSearchParams({ market, symbol, limit: String(limit) })
    const wire = await getJson<{ ok: boolean; trades: TradeTick[] }>(`/dshtrading/api/trades?${query.toString()}`)
    return Array.isArray(wire.trades) ? wire.trades : []
  } catch {
    return null
  }
}

/** 动态全集标的名册（Issue #15）：未支持或失败时回退空数组。 */
export async function fetchSymbols(market: MarketId): Promise<Array<{ symbol: string; name?: string }>> {
  const query = new URLSearchParams({ market })
  const wire = await getJson<{ symbols: Array<{ symbol: string; name?: string }> }>(`/dshtrading/api/symbols?${query.toString()}`)
  return Array.isArray(wire.symbols) ? wire.symbols : []
}

/** 拉取自定义指标列表（Issue #19）。 */
export async function fetchCustomIndicators(): Promise<CustomIndicatorRecord[]> {
  try {
    const wire = await getJson<{ ok: boolean; indicators: CustomIndicatorRecord[] }>('/dshtrading/api/indicators/custom')
    return Array.isArray(wire.indicators) ? wire.indicators : []
  } catch {
    return []
  }
}

/** 删除自定义指标。 */
export async function deleteCustomIndicator(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/indicators/custom?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; removed?: boolean }
    return wire.ok === true && wire.removed === true
  } catch {
    return false
  }
}

/** 拉取知识库卡片全集列表（Issue #24）。 */
export async function fetchKnowledgeCards(): Promise<KnowledgeCard[]> {
  try {
    const wire = await getJson<{ ok: boolean; cards: KnowledgeCard[] }>('/dshtrading/api/knowledge/cards')
    return Array.isArray(wire.cards) ? wire.cards : []
  } catch (err) {
    console.warn('[dsh-trading] fetchKnowledgeCards failed, fallback to empty:', err)
    return []
  }
}

/* ------------------------------------------------------------------ */
/* SSE 失效信号订阅（issue #30 / P1）                                        */
/* ------------------------------------------------------------------ */

/** 拉取自定义策略名册（issue #31，桥 /strategies/custom；前端校验后并入名册）。 */
export async function fetchCustomStrategies(): Promise<CustomStrategyRecord[]> {
  try {
    const wire = await getJson<{ ok: boolean; strategies: CustomStrategyRecord[] }>('/dshtrading/api/strategies/custom')
    return Array.isArray(wire.strategies) ? wire.strategies : []
  } catch (err) {
    console.warn('[dsh-trading] fetchCustomStrategies failed, fallback to empty:', err)
    return []
  }
}

/** 删除自定义策略（issue #31）。 */
export async function deleteCustomStrategy(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/strategies/custom?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; removed?: boolean }
    return wire.ok === true && wire.removed === true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 自选股 + 选中标的（issue #32 / P3）：host store 为 SSOT                  */
/* ------------------------------------------------------------------ */

/** host 侧自选行（WatchlistsMap：market → 行数组；不含客户端种子回退）。 */
export type HostWatchlists = Record<string, Array<{ market: string; symbol: string; name?: string }>>

/** 读取 host 自选全量（启动同步与 SSE 重拉）。 */
export async function fetchHostWatchlists(): Promise<HostWatchlists> {
  try {
    const wire = await getJson<{ ok: boolean; watchlists: HostWatchlists }>('/dshtrading/api/watchlists')
    return wire.watchlists ?? {}
  } catch (err) {
    console.warn('[dsh-trading] fetchHostWatchlists failed, fallback to local mirror:', err)
    throw err instanceof BridgeError ? err : new BridgeError(0, 'watchlists unavailable')
  }
}

/** 追加一行（POST /watchlists）。 */
export async function addHostWatchlistRow(instrument: { market: string; symbol: string; name?: string }): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/watchlists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(instrument),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 移除一行（DELETE /watchlists?market&symbol）。 */
export async function removeHostWatchlistRow(market: string, symbol: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const response = await fetch(`/dshtrading/api/watchlists?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 一次性迁移导入（POST /watchlists/import；host 非空时服务端拒绝，幂等）。 */
export async function importHostWatchlists(rows: HostWatchlists): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/watchlists/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchlists: rows }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 读取 host 选中标的（GET /selection）。 */
export async function fetchHostSelection(): Promise<{ market: string; symbol: string; name?: string } | null> {
  try {
    const wire = await getJson<{ ok: boolean; instrument: { market: string; symbol: string; name?: string } | null }>('/dshtrading/api/selection')
    return wire.instrument ?? null
  } catch {
    return null
  }
}

/** 设置 host 选中标的（PUT /selection；watchlist_select 工具与左栏点击同源）。 */
export async function putHostSelection(instrument: { market: string; symbol: string; name?: string } | null): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/selection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instrument }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/**
 * store 词汇（v1）：镜像 host 半 @dsh-trading/eventbus 的 TradingEventStore.
 * 浏览器半不 import node 包（避免把 cordis 拖进 client bundle）——词汇是封闭
 * 小集合，镜像漂移的代价是 handler 不触发（降级为现状），可接受。
 */
export type TradingEventStoreName =
  | 'indicators'
  | 'strategies'
  | 'knowledge'
  | 'watchlists'
  | 'selection'
  | 'routing'

type TradingEventHandlers = Partial<Record<TradingEventStoreName, () => void>>

/** 模块级单例：多视图共享一条 EventSource 连接（多标签页各自一条，天然隔离）。 */
let tradingEventSource: EventSource | null = null
const tradingEventListeners = new Set<(store: TradingEventStoreName) => void>()

function ensureTradingEventSource(): void {
  if (tradingEventSource !== null) return
  // 无 EventSource（老浏览器/非 web 环境）→ 一次性 fetch 的现状兜底。
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return
  const source = new EventSource('/dshtrading/api/events')
  source.addEventListener('store.changed', (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data as string) as { store?: string }
      if (typeof data.store !== 'string') return
      for (const listener of [...tradingEventListeners]) listener(data.store as TradingEventStoreName)
    } catch {
      /* 坏帧忽略（总线只发 JSON 信号，正常不会发生） */
    }
  })
  source.onerror = () => {
    /* EventSource 原生自动重连；桥未挂载（503）时持续失败 = 降级现状，不打扰用户 */
  }
  tradingEventSource = source
}

/**
 * 订阅失效信号：store 名 → refetch 回调。返回退订函数；最后一个订阅者退订时
 * 关闭连接（视图互斥挂载下 quote/strategy/knowledge 轮流订阅不堆积）。
 */
export function subscribeTradingEvents(handlers: TradingEventHandlers): () => void {
  ensureTradingEventSource()
  const listener = (store: TradingEventStoreName): void => { handlers[store]?.() }
  tradingEventListeners.add(listener)
  return () => {
    tradingEventListeners.delete(listener)
    if (tradingEventListeners.size === 0 && tradingEventSource !== null) {
      tradingEventSource.close()
      tradingEventSource = null
    }
  }
}

/* ------------------------------------------------------------------ */
/* tradingBridge client 服务（issue #34 / P5）                              */
/* ------------------------------------------------------------------ */

/**
 * 中栏视图包（client-ui-strategies / client-ui-knowledge 及未来的第三方视图）
 * 对桥的唯一依赖面。收口为 cordis client 服务（provide 'tradingBridge'），
 * 原因有二：
 * 1. 插件间协作必须走服务 inject（一切皆插件裁决——client 插件间不得 import
 *    彼此内部模块）；
 * 2. SSE 单例与 fetch 封装留在 shell 内（本模块），多视图包共享同一条
 *    EventSource 连接——各包自开连接会随拆包数量线性堆积。
 *
 * 视图包不 import 本模块；未安装 shell 时 inject 回调不触发，视图静默不注册
 * （可选依赖语义）。
 */
export interface TradingBridgeService {
  fetchKlines: typeof fetchKlines
  fetchCustomStrategies: typeof fetchCustomStrategies
  fetchKnowledgeCards: typeof fetchKnowledgeCards
  subscribeTradingEvents: typeof subscribeTradingEvents
}

/** 服务装配（shell apply 时以本模块函数 provide，零转发成本）。 */
export function createTradingBridgeService(): TradingBridgeService {
  return {
    fetchKlines,
    fetchCustomStrategies,
    fetchKnowledgeCards,
    subscribeTradingEvents,
  }
}
