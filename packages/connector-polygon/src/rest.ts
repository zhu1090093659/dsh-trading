/**
 * @dshtrading/connector-polygon/rest
 * Polygon.io (Massive) 美股/全球高频 REST 客户端。
 */

import type {
  AccountBalance,
  Interval,
  Kline,
  Order,
  OrderRequest,
  Position,
  Ticker,
  TradingErrorCode,
} from '@dshtrading/api'

export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'] as const

export function toPolygonTimespan(interval: Interval): { multiplier: number; timespan: string } {
  switch (interval) {
    case '1m': return { multiplier: 1, timespan: 'minute' }
    case '5m': return { multiplier: 5, timespan: 'minute' }
    case '15m': return { multiplier: 15, timespan: 'minute' }
    case '30m': return { multiplier: 30, timespan: 'minute' }
    case '1h': return { multiplier: 1, timespan: 'hour' }
    case '4h': return { multiplier: 4, timespan: 'hour' }
    case '1d': return { multiplier: 1, timespan: 'day' }
    case '1w': return { multiplier: 1, timespan: 'week' }
    case '1M': return { multiplier: 1, timespan: 'month' }
  }
}

export function parseIntervalMs(interval: Interval): number {
  switch (interval) {
    case '1m': return 60 * 1000
    case '5m': return 5 * 60 * 1000
    case '15m': return 15 * 60 * 1000
    case '30m': return 30 * 60 * 1000
    case '1h': return 60 * 60 * 1000
    case '4h': return 4 * 60 * 60 * 1000
    case '1d': return 24 * 60 * 60 * 1000
    case '1w': return 7 * 24 * 60 * 60 * 1000
    case '1M': return 30 * 24 * 60 * 60 * 1000
  }
}

export function normalizeUsSymbol(raw: string): string {
  const clean = raw.trim().toUpperCase()
  if (!clean) throw new TradingServiceError('TRADING_INVALID_ARGUMENT', 'Symbol cannot be empty')
  return clean
}

export interface PolygonRestOptions {
  baseUrl?: string
  apiKey?: string
  fetchImpl?: typeof fetch
}

export class PolygonRestClient {
  readonly baseUrl: string
  private readonly apiKey?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: PolygonRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://api.polygon.io'
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string): Promise<T> {
    const sep = path.includes('?') ? '&' : '?'
    const keyQuery = this.apiKey ? `${sep}apiKey=${encodeURIComponent(this.apiKey)}` : ''
    const url = `${this.baseUrl}${path}${keyQuery}`

    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Polygon HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Polygon network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const sym = normalizeUsSymbol(symbol)
    const data = await this.requestJson<{
      ticker: string
      resultsCount: number
      results?: Array<{
        T?: string
        c: number
        h: number
        l: number
        o: number
        v: number
        t: number
      }>
    }>(`/v2/aggs/ticker/${sym}/prev`)

    if (!data.results || data.results.length === 0) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Polygon quote not found for ${sym}`)
    }

    const row = data.results[0]
    return {
      symbol: sym,
      price: row.c,
      volume: row.v,
      timestamp: row.t,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const sym = normalizeUsSymbol(symbol)
    const { multiplier, timespan } = toPolygonTimespan(interval)
    const stepMs = parseIntervalMs(interval)
    const toDate = new Date().toISOString().slice(0, 10)
    const fromDate = new Date(Date.now() - limit * stepMs * 2).toISOString().slice(0, 10)

    const data = await this.requestJson<{
      results?: Array<{
        c: number
        h: number
        l: number
        o: number
        v: number
        t: number
      }>
    }>(`/v2/aggs/ticker/${sym}/range/${multiplier}/${timespan}/${fromDate}/${toDate}?limit=${limit}&sort=asc`)

    if (!data.results || !Array.isArray(data.results)) {
      return []
    }

    return data.results.map((r) => ({
      openTime: r.t,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
      closeTime: r.t + stepMs - 1,
    }))
  }

  async getTickerDetails(symbol: string): Promise<Record<string, unknown>> {
    const sym = normalizeUsSymbol(symbol)
    const data = await this.requestJson<{ results?: Record<string, unknown> }>(`/v3/reference/tickers/${sym}`)
    return data.results ?? {}
  }

  async getBalance(): Promise<AccountBalance> {
    return { currency: 'USD', available: 100000, total: 100000 }
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    return {
      id: `sim-polygon-${Date.now()}`,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      status: 'filled',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: true,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(_creds: unknown, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }
