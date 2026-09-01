/**
 * Bridge client: same-origin fetch wrappers over /dshtrading/api (the node
 * half registers the route behind the browser-auth fence; same-origin fetch
 * carries the auth cookie by default).
 */
import type { Kline, MarketId, MarketInfo, TickerOutcome } from './types.ts'
import type { CustomIndicatorRecord } from '@dsh-trading/indicators'
import type { KnowledgeCard } from '@dsh-trading/knowledge'

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

/**
 * store 词汇（v1）：镜像 host 半 @dsh-trading/eventbus 的 TradingEventStore。
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
