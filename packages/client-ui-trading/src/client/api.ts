/**
 * Bridge client: same-origin fetch wrappers over /dshtrading/api (the node
 * half registers the route behind the browser-auth fence; same-origin fetch
 * carries the auth cookie by default).
 */
import type { Kline, MarketId, MarketInfo, TickerOutcome } from './types.ts'

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
