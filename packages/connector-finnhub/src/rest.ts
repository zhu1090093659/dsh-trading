/**
 * @dsh-trading/connector-finnhub/rest
 * Finnhub 美股/外汇/加密 REST 客户端（支持 Quote 与 Candles）。
 */

import type {
  AccountBalance,
  Interval,
  Kline,
  Order,
  OrderRequest,
  Position,
  StockFundamentals,
  Ticker,
  TradingErrorCode,
} from '@dsh-trading/api'

export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'] as const

export function toFinnhubResolution(interval: Interval): string {
  switch (interval) {
    case '1m': return '1'
    case '5m': return '5'
    case '15m': return '15'
    case '30m': return '30'
    case '1h': return '60'
    case '1d': return 'D'
    case '1w': return 'W'
    case '1M': return 'M'
  }
}

export function parseIntervalSeconds(interval: Interval): number {
  switch (interval) {
    case '1m': return 60
    case '5m': return 5 * 60
    case '15m': return 15 * 60
    case '30m': return 30 * 60
    case '1h': return 60 * 60
    case '1d': return 24 * 60 * 60
    case '1w': return 7 * 24 * 60 * 60
    case '1M': return 30 * 24 * 60 * 60
  }
}

export function normalizeUsSymbol(raw: string): string {
  const clean = raw.trim().toUpperCase()
  if (!clean) throw new TradingServiceError('TRADING_INVALID_ARGUMENT', 'Symbol cannot be empty')
  return clean
}

export interface FinnhubRestOptions {
  baseUrl?: string
  apiKey?: string
  fetchImpl?: typeof fetch
}

export class FinnhubRestClient {
  readonly baseUrl: string
  private readonly apiKey?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: FinnhubRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://finnhub.io/api/v1'
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string): Promise<T> {
    const sep = path.includes('?') ? '&' : '?'
    const tokenQuery = this.apiKey ? `${sep}token=${encodeURIComponent(this.apiKey)}` : ''
    const url = `${this.baseUrl}${path}${tokenQuery}`
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Finnhub request failed: HTTP ${res.status}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Finnhub network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const sym = normalizeUsSymbol(symbol)
    const data = await this.requestJson<{ c?: number; d?: number; dp?: number; h?: number; l?: number; o?: number; pc?: number; t?: number }>(
      `/quote?symbol=${sym}`,
    )

    if (data.c === undefined || data.c === 0) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Finnhub quote not found for ${sym}`)
    }

    const price = data.c
    const timestamp = typeof data.t === 'number' && data.t > 0 ? data.t * 1000 : Date.now()

    return {
      symbol: sym,
      price,
      timestamp,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const sym = normalizeUsSymbol(symbol)
    const resolution = toFinnhubResolution(interval)
    const stepSec = parseIntervalSeconds(interval)
    const nowSec = Math.floor(Date.now() / 1000)
    const fromSec = nowSec - (limit * stepSec * 2)

    const data = await this.requestJson<{
      s: string
      c?: number[]
      h?: number[]
      l?: number[]
      o?: number[]
      t?: number[]
      v?: number[]
    }>(`/stock/candle?symbol=${sym}&resolution=${resolution}&from=${fromSec}&to=${nowSec}`)

    if (data.s !== 'ok' || !Array.isArray(data.t) || data.t.length === 0) {
      return []
    }

    const count = Math.min(data.t.length, limit)
    const startIdx = data.t.length - count
    const klines: Kline[] = []

    for (let i = startIdx; i < data.t.length; i++) {
      const openTime = data.t[i] * 1000
      klines.push({
        openTime,
        open: data.o?.[i] ?? 0,
        high: data.h?.[i] ?? 0,
        low: data.l?.[i] ?? 0,
        close: data.c?.[i] ?? 0,
        volume: data.v?.[i] ?? 0,
        closeTime: openTime + (stepSec * 1000) - 1,
      })
    }

    return klines
  }

  async getNews(symbol: string): Promise<Array<Record<string, unknown>>> {
    const sym = normalizeUsSymbol(symbol)
    const today = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    const data = await this.requestJson<Array<Record<string, unknown>>>(
      `/company-news?symbol=${sym}&from=${from}&to=${today}`,
    )
    return Array.isArray(data) ? data.slice(0, 10) : []
  }

  async getFundamentals(symbol: string): Promise<StockFundamentals> {
    const sym = normalizeUsSymbol(symbol)
    const data = await this.requestJson<{ metric?: Record<string, number> }>(
      `/stock/metric?symbol=${sym}&metric=all`,
    ).catch(() => ({ metric: undefined }))

    const m = data?.metric ?? {}
    return {
      symbol: sym,
      peTtm: m.peNormalizedAnnual ?? m.peTTM ?? m.peBasicExclExtraTTM,
      pb: m.pbAnnual ?? m.pbTTM,
      ps: m.psTTM ?? m.psAnnual,
      dividendYield: m.dividendYieldIndicatedAnnual,
      fiftyTwoWeekHigh: m['52WeekHigh'],
      fiftyTwoWeekLow: m['52WeekLow'],
      marketCap: m.marketCapitalization ? m.marketCapitalization * 1_000_000 : undefined,
      timestamp: Date.now(),
    }
  }

  async listInstruments(query?: string): Promise<Array<{ symbol: string; name: string }>> {
    if (!query) return []
    const data = await this.requestJson<{ result?: Array<{ symbol: string; description: string }> }>(
      `/search?q=${encodeURIComponent(query)}`,
    )
    const list = data.result ?? []
    return list.map((r) => ({ symbol: r.symbol, name: r.description }))
  }

  async getBalance(): Promise<AccountBalance> {
    return { currency: 'USD', available: 100000, total: 100000 }
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    return {
      id: `sim-finnhub-${Date.now()}`,
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
