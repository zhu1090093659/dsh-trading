import * as crypto from 'node:crypto'
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

export function generateLongbridgeSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: string | number,
  nonce: string,
  body = '',
): string {
  const payload = `${method.toUpperCase()}|${path}|${timestamp}|${nonce}|${body}`
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
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
  readonly appKey?: string
  readonly appSecret?: string
  readonly accessToken?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: LongbridgeRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? (process.env.LONGBRIDGE_API_URL || 'https://openapi.longportapp.com')
    this.appKey = options.appKey ?? process.env.LONGBRIDGE_APP_KEY
    this.appSecret = options.appSecret ?? process.env.LONGBRIDGE_APP_SECRET
    this.accessToken = options.accessToken ?? process.env.LONGBRIDGE_ACCESS_TOKEN
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase()
    const url = `${this.baseUrl}${path}`
    const timestamp = Date.now().toString()
    const nonce = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
    const bodyStr = options.body ? String(options.body) : ''

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    }

    if (this.accessToken) {
      headers['authorization'] = this.accessToken.startsWith('Bearer ') ? this.accessToken : `Bearer ${this.accessToken}`
    }
    if (this.appKey) {
      headers['x-hk-key'] = this.appKey
      headers['x-api-key'] = this.appKey
      headers['x-hk-timestamp'] = timestamp
      headers['x-hk-nonce'] = nonce
      if (this.appSecret) {
        headers['x-hk-signature'] = generateLongbridgeSignature(this.appSecret, method, path, timestamp, nonce, bodyStr)
      }
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
    if (!this.appKey || !this.accessToken) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Longbridge: appKey and accessToken are required for getBalance')
    }
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: {
        list?: Array<{
          total_cash?: string
          net_assets?: string
          currency?: string
        }>
      }
    }>('/v1/asset/account')

    if (res.code !== 0 || !res.data?.list || res.data.list.length === 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Longbridge getBalance failed: ${res.message ?? `code ${res.code}`}`)
    }

    const first = res.data.list[0]
    const available = parseFloat(first.total_cash || '0')
    const total = parseFloat(first.net_assets || first.total_cash || '0')

    return {
      currency: first.currency ?? 'HKD',
      available,
      total,
    }
  }

  async getPositions(): Promise<Position[]> {
    if (!this.appKey || !this.accessToken) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Longbridge: appKey and accessToken are required for getPositions')
    }
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: {
        channels?: Array<{
          positions?: Array<{
            symbol: string
            quantity: string
            cost_price: string
            unrealized_pnl?: string
          }>
        }>
      }
    }>('/v1/trade/stock/position')

    if (res.code !== 0 || !Array.isArray(res.data?.channels)) return []
    const positions: Position[] = []
    for (const channel of res.data.channels) {
      if (Array.isArray(channel.positions)) {
        for (const p of channel.positions) {
          positions.push({
            symbol: toLongbridgeSymbol(p.symbol).canonical,
            quantity: parseFloat(p.quantity || '0'),
            entryPrice: parseFloat(p.cost_price || '0'),
            unrealizedPnl: parseFloat(p.unrealized_pnl || '0'),
          })
        }
      }
    }
    return positions
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    if (!this.appKey || !this.accessToken) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Longbridge: appKey and accessToken are required for placeOrder')
    }
    const { symbol: lbSymbol, canonical } = toLongbridgeSymbol(req.symbol)
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: { order_id?: string }
    }>('/v1/trade/order', {
      method: 'POST',
      body: JSON.stringify({
        symbol: lbSymbol,
        order_type: req.type === 'market' ? 'MO' : 'LO',
        side: req.side === 'buy' ? 'Buy' : 'Sell',
        submitted_quantity: String(req.quantity),
        submitted_price: req.price ? String(req.price) : undefined,
        time_in_force: 'Day',
      }),
    })

    if (res.code !== 0 || !res.data?.order_id) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Longbridge placeOrder failed: ${res.message ?? `code ${res.code}`}`)
    }

    return {
      id: res.data.order_id,
      symbol: canonical,
      side: req.side,
      type: req.type,
      status: 'new',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(_creds: unknown, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    if (!this.appKey || !this.accessToken) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Longbridge: appKey and accessToken are required for cancelOrder')
    }
    const res = await this.requestJson<{ code: number; message?: string }>(`/v1/trade/order?order_id=${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
    })

    if (res.code !== 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Longbridge cancelOrder failed: ${res.message ?? `code ${res.code}`}`)
    }

    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }
