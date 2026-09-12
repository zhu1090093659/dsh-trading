/**
 * Client-half shared types. Wire shapes mirror the node-half bridge
 * (src/bridge.ts) and @dshtrading/api's data contracts — type-only imports,
 * erased at bundle time (the client half must not require non-seed modules).
 */
import type { AccountBalance, DerivativesData, DerivativesHistory, DerivativesPoint, Kline, Order, Orderbook, Position, StockFundamentals, Ticker, TradeFill, TradeTick } from '@dshtrading/api'

/** Markets served by the bridge (subset = installed connector set). */
export type MarketId = 'crypto' | 'us' | 'cn' | 'hk' | 'futures'

/** One watchable instrument (a watchlist row / the quote stage's subject). */
export interface Instrument {
  market: MarketId
  symbol: string
  /** Display label (seed names, or the raw symbol for user-added rows). */
  name?: string
  /** 所属自定义分组 id（issue #82；多归属，缺省/空 = 未分组；注册表见 groups store）。 */
  groups?: string[]
}

/** 自定义分组（镜像 host 侧 WatchlistGroup wire 形状；type-only，不打进 bundle）。 */
export interface WatchlistGroupMeta {
  id: string
  name: string
  createdAt: number
}

export interface MarketInfo {
  id: MarketId
  provider?: string
}

export type TickerOutcome =
  | { ok: true; ticker: Ticker }
  | { ok: false; code: string; message: string }

export type { Kline, Ticker, StockFundamentals, DerivativesData, DerivativesHistory, DerivativesPoint, Orderbook, TradeTick, Position, Order, AccountBalance, TradeFill }

/** Per-instrument cached reference series: closes for the sparkline + prev daily close for change%. */
export interface ReferenceSeries {
  closes: number[]
  prevClose: number | undefined
  fetchedAt: number
  /** intraday = 当日/最近交易日分钟线（60s 轮询）；daily = 分钟线不可用时的日 K 降级（TTL 内复用后再重试分钟线）。 */
  mode: 'intraday' | 'daily'
  /** intraday 模式下实测可用的分钟粒度（连接器能力各异，成功后记住，避免每拍重试必失败的粒度）。 */
  interval?: '1m' | '5m'
  /** intraday 模式下每点的固定交易时段 x 位置（0..1）；crypto/日 K 降级无此字段（等距铺满）。 */
  xFractions?: number[]
}
