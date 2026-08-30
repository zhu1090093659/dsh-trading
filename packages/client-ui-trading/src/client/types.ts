/**
 * Client-half shared types. Wire shapes mirror the node-half bridge
 * (src/bridge.ts) and @dsh-trading/api's data contracts — type-only imports,
 * erased at bundle time (the client half must not require non-seed modules).
 */
import type { Kline, Ticker } from '@dsh-trading/api'

/** Markets served by the bridge (subset = installed connector set). */
export type MarketId = 'crypto' | 'us' | 'cn' | 'hk'

/** One watchable instrument (a watchlist row / the quote stage's subject). */
export interface Instrument {
  market: MarketId
  symbol: string
  /** Display label (seed names, or the raw symbol for user-added rows). */
  name?: string
}

export interface MarketInfo {
  id: MarketId
  provider?: string
}

export type TickerOutcome =
  | { ok: true; ticker: Ticker }
  | { ok: false; code: string; message: string }

export type { Kline, Ticker }

/** Per-instrument cached reference series: closes for the sparkline + prev daily close for change%. */
export interface ReferenceSeries {
  closes: number[]
  prevClose: number | undefined
  fetchedAt: number
}
