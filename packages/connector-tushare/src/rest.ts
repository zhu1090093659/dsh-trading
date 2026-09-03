/**
 * @dshtrading/connector-tushare/rest
 * Tushare Pro A 股 REST 客户端（支持日/分钟线与估值财务分析）。
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

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'] as const

export function toTushareCode(symbol: string): string {
  const clean = symbol.trim().toUpperCase()
  if (clean.includes('.')) return clean
  if (clean.startsWith('6') || clean.startsWith('5') || clean.startsWith('9')) {
    return `${clean}.SH`
  }
  if (clean.startsWith('0') || clean.startsWith('3') || clean.startsWith('1')) {
    return `${clean}.SZ`
  }
  if (clean.startsWith('8') || clean.startsWith('4')) {
    return `${clean}.BJ`
  }
  return `${clean}.SH`
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

export interface TushareRestOptions {
  baseUrl?: string
  token?: string
  fetchImpl?: typeof fetch
}

export class TushareRestClient {
  readonly baseUrl: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: TushareRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://api.tushare.pro'
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestApi<T>(apiName: string, params: Record<string, unknown> = {}, fields?: string): Promise<T[]> {
    if (!this.token) {
      throw new TradingServiceError(
        'TRADING_CREDENTIALS_MISSING',
        'Tushare token missing. Please set TUSHARE_TOKEN in environment or credentials.',
      )
    }

    const payload = {
      api_name: apiName,
      token: this.token,
      params,
      fields: fields ?? '',
    }

    try {
      const res = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Tushare HTTP ${res.status}: ${res.statusText}`)
      }
      const data = await res.json() as {
        code: number
        msg: string | null
        data?: { fields: string[]; items: unknown[][] }
      }

      if (data.code !== 0 || !data.data) {
        throw new TradingServiceError(
          'TRADING_EXCHANGE_ERROR',
          `Tushare API error (code ${data.code}): ${data.msg ?? 'unknown error'}`,
        )
      }

      const { fields: fieldNames, items } = data.data
      return items.map((row) => {
        const obj: Record<string, unknown> = {}
        fieldNames.forEach((name, idx) => {
          obj[name] = row[idx]
        })
        return obj as T
      })
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Tushare network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const tsCode = toTushareCode(symbol)
    const items = await this.requestApi<{
      ts_code: string
      trade_date: string
      open: number
      high: number
      low: number
      close: number
      vol: number
      amount: number
    }>('daily', { ts_code: tsCode, limit: 1 })

    if (items.length === 0) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Tushare daily data not found for ${symbol}`)
    }

    const latest = items[0]
    const year = parseInt(latest.trade_date.slice(0, 4), 10)
    const month = parseInt(latest.trade_date.slice(4, 6), 10) - 1
    const day = parseInt(latest.trade_date.slice(6, 8), 10)
    const timestamp = new Date(year, month, day, 15, 0, 0).getTime()

    return {
      symbol: tsCode,
      price: latest.close,
      volume: latest.vol,
      timestamp,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const tsCode = toTushareCode(symbol)
    const stepMs = parseIntervalMs(interval)

    if (['1m', '5m', '15m', '30m', '1h'].includes(interval)) {
      const freq = interval === '1h' ? '60min' : `${interval.replace('m', '')}min`
      const items = await this.requestApi<{
        ts_code: string
        trade_time: string
        open: number
        close: number
        high: number
        low: number
        vol: number
      }>('stk_mins', { ts_code: tsCode, freq }, 'trade_time,open,close,high,low,vol')

      const sliced = items.slice(0, limit).reverse()
      return sliced.map((item) => {
        const openTime = new Date(item.trade_time.replace(/-/g, '/')).getTime()
        return {
          openTime,
          open: item.open,
          high: item.high,
          low: item.low,
          close: item.close,
          volume: item.vol,
          closeTime: openTime + stepMs - 1,
        }
      })
    }

    const apiName = interval === '1w' ? 'weekly' : interval === '1M' ? 'monthly' : 'daily'
    const items = await this.requestApi<{
      ts_code: string
      trade_date: string
      open: number
      high: number
      low: number
      close: number
      vol: number
    }>(apiName, { ts_code: tsCode }, 'trade_date,open,high,low,close,vol')

    const sliced = items.slice(0, limit).reverse()
    return sliced.map((item) => {
      const year = parseInt(item.trade_date.slice(0, 4), 10)
      const month = parseInt(item.trade_date.slice(4, 6), 10) - 1
      const day = parseInt(item.trade_date.slice(6, 8), 10)
      const openTime = new Date(year, month, day, 9, 30, 0).getTime()
      return {
        openTime,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.vol,
        closeTime: openTime + stepMs - 1,
      }
    })
  }

  async getDailyBasic(symbol: string): Promise<Record<string, unknown>> {
    const tsCode = toTushareCode(symbol)
    const items = await this.requestApi<Record<string, unknown>>('daily_basic', { ts_code: tsCode, limit: 1 })
    return items.length > 0 ? items[0] : {}
  }

  async getBalance(): Promise<AccountBalance> {
    return { currency: 'CNY', available: 1000000, total: 1000000 }
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    const tsCode = toTushareCode(req.symbol)
    return {
      id: `sim-ts-${Date.now()}`,
      symbol: tsCode,
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
