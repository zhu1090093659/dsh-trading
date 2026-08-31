/**
 * @dsh-trading/connector-ccxt/rest
 * CCXT 跨所加密通用 REST 客户端。
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

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'] as const

export const SUPPORTED_EXCHANGES = [
  'binance',
  'okx',
  'bybit',
  'gateio',
  'kucoin',
  'kraken',
  'coinbase',
  'bitfinex',
  'htx',
] as const

export function normalizeSymbol(raw: string): string {
  const clean = raw.trim().toUpperCase().replace(/[-_]/g, '')
  if (clean.includes('/')) return clean.replace('/', '')
  return clean
}

export interface CcxtRestOptions {
  exchange?: string
  apiKey?: string
  secret?: string
  fetchImpl?: typeof fetch
}

export class CcxtRestClient {
  readonly exchange: string
  private readonly apiKey?: string
  private readonly secret?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: CcxtRestOptions = {}) {
    this.exchange = options.exchange ?? 'binance'
    this.apiKey = options.apiKey
    this.secret = options.secret
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(url: string): Promise<T> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `CCXT HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `CCXT network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string, exchange: string = this.exchange): Promise<Ticker> {
    const sym = normalizeSymbol(symbol)
    if (exchange === 'bybit') {
      const url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`
      const res = await this.requestJson<{ result?: { list?: Array<{ symbol: string; lastPrice: string; volume24h: string }> } }>(url)
      const row = res.result?.list?.[0]
      if (!row) throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `CCXT/Bybit ticker not found: ${symbol}`)
      return {
        symbol: sym,
        price: parseFloat(row.lastPrice),
        volume: parseFloat(row.volume24h),
        timestamp: Date.now(),
      }
    }

    if (exchange === 'okx') {
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol.includes('-') ? symbol : `${sym.replace('USDT', '')}-USDT`}`
      const res = await this.requestJson<{ data?: Array<{ instId: string; last: string; vol24h: string; ts: string }> }>(url)
      const row = res.data?.[0]
      if (!row) throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `CCXT/OKX ticker not found: ${symbol}`)
      return {
        symbol: sym,
        price: parseFloat(row.last),
        volume: parseFloat(row.vol24h),
        timestamp: parseInt(row.ts, 10),
      }
    }

    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`
    const data = await this.requestJson<{ symbol: string; lastPrice: string; volume: string; closeTime: number }>(url)
    return {
      symbol: sym,
      price: parseFloat(data.lastPrice),
      volume: parseFloat(data.volume),
      timestamp: data.closeTime,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100, exchange: string = this.exchange): Promise<Kline[]> {
    const sym = normalizeSymbol(symbol)
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`
    const data = await this.requestJson<Array<[number, string, string, string, string, string, number]>>(url)
    if (!Array.isArray(data)) return []
    return data.map((r) => ({
      openTime: r[0],
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
      closeTime: r[6],
    }))
  }

  async getBalance(): Promise<AccountBalance> {
    return { currency: 'USDT', available: 100000, total: 100000 }
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    const sym = normalizeSymbol(req.symbol)
    return {
      id: `sim-ccxt-${Date.now()}`,
      symbol: sym,
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
