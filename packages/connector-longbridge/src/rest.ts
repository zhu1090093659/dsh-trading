/**
 * @dsh-trading/connector-longbridge/rest
 * 长桥证券 (Longbridge/LongPort) OpenAPI 客户端（港美股行情与交易）。
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

export function toLongbridgePeriod(interval: Interval): string {
  switch (interval) {
    case '1m': return '1m'
    case '5m': return '5m'
    case '15m': return '15m'
    case '30m': return '30m'
    case '1h': return '60m'
    case '1d': return 'day'
    case '1w': return 'week'
    case '1M': return 'month'
  }
}

export function parseIntervalMs(interval: Interval): number {
  switch (interval) {
    case '1m': return 60 * 1000
    case '5m': return 5 * 60 * 1000
    case '15m': return 15 * 60 * 1000
    case '30m': return 30 * 60 * 1000
    case '1h': return 60 * 60 * 1000
    case '1d': return 24 * 60 * 60 * 1000
    case '1w': return 7 * 24 * 60 * 60 * 1000
    case '1M': return 30 * 24 * 60 * 60 * 1000
  }
}

export function toLongbridgeSymbol(raw: string): { symbol: string; canonical: string } {
  const clean = raw.trim().toUpperCase()
  if (clean.endsWith('.HK')) {
    const num = clean.replace('.HK', '').padStart(5, '0')
    return { symbol: `${num}.HK`, canonical: `${num}.HK` }
  }
  if (/^\d{1,5}$/.test(clean)) {
    const num = clean.padStart(5, '0')
    return { symbol: `${num}.HK`, canonical: `${num}.HK` }
  }
  return { symbol: clean, canonical: clean }
}

export interface LongbridgeRestOptions {
  baseUrl?: string
  appKey?: string
  appSecret?: string
  accessToken?: string
  fetchImpl?: typeof fetch
}

export class LongbridgeRestClient {
  readonly baseUrl: string
  private readonly appKey?: string
  private readonly appSecret?: string
  private readonly accessToken?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: LongbridgeRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://openapi.longportapp.com'
    this.appKey = options.appKey
    this.appSecret = options.appSecret
    this.accessToken = options.accessToken
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    }

    if (this.accessToken) {
      headers['authorization'] = this.accessToken
    }
    if (this.appKey) {
      headers['x-api-key'] = this.appKey
    }

    try {
      const res = await this.fetchImpl(url, { ...options, headers })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Longbridge HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Longbridge network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { symbol: lbSymbol, canonical } = toLongbridgeSymbol(symbol)
    const data = await this.requestJson<{
      code: number
      data?: Array<{ symbol: string; last_done: string; volume: string; timestamp: number }>
    }>(`/v1/quote/realtime?symbol=${encodeURIComponent(lbSymbol)}`)

    if (data.code !== 0 || !data.data || data.data.length === 0) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Longbridge quote not found for ${symbol}`)
    }

    const row = data.data[0]
    const price = parseFloat(row.last_done || '0')
    const volume = parseFloat(row.volume || '0')
    const timestamp = row.timestamp ? row.timestamp * 1000 : Date.now()

    return {
      symbol: canonical,
      price,
      volume,
      timestamp,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { symbol: lbSymbol } = toLongbridgeSymbol(symbol)
    const period = toLongbridgePeriod(interval)
    const stepMs = parseIntervalMs(interval)

    const data = await this.requestJson<{
      code: number
      data?: {
        candlesticks?: Array<{
          open: string
          close: string
          high: string
          low: string
          volume: string
          timestamp: number
        }>
      }
    }>(`/v1/quote/candlesticks?symbol=${encodeURIComponent(lbSymbol)}&period=${period}&count=${limit}`)

    if (data.code !== 0 || !data.data?.candlesticks) {
      return []
    }

    return data.data.candlesticks.map((c) => {
      const openTime = c.timestamp * 1000
      return {
        openTime,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
        closeTime: openTime + stepMs - 1,
      }
    })
  }

  async getBalance(): Promise<AccountBalance> {
    return { currency: 'HKD', available: 1000000, total: 1000000 }
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    const { canonical } = toLongbridgeSymbol(req.symbol)
    return {
      id: `sim-lb-${Date.now()}`,
      symbol: canonical,
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
