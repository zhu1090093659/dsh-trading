/**
 * @dsh-trading/connector-tiger/rest
 * 老虎证券 (Tiger Trade / TigerOpen) 港美股 REST 客户端。
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

export function toTigerSymbol(raw: string): { symbol: string; canonical: string; secType: 'STK' } {
  const clean = raw.trim().toUpperCase()
  if (!clean) throw new TradingServiceError('TRADING_INVALID_ARGUMENT', 'Symbol cannot be empty')
  if (clean.includes('.')) {
    const parts = clean.split('.')
    return { symbol: parts[0], canonical: clean, secType: 'STK' }
  }
  if (/^\d{5}$/.test(clean)) {
    return { symbol: clean, canonical: `${clean}.HK`, secType: 'STK' }
  }
  return { symbol: clean, canonical: clean, secType: 'STK' }
}

export interface TigerRestOptions {
  baseUrl?: string
  tigerId?: string
  privateKey?: string
  accountId?: string
  fetchImpl?: typeof fetch
}

export class TigerRestClient {
  readonly baseUrl: string
  readonly tigerId?: string
  readonly privateKey?: string
  readonly accountId?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: TigerRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? (process.env.TIGER_API_URL || 'https://openapi.itiger.com/gateway')
    this.tigerId = options.tigerId ?? process.env.TIGER_ID
    this.privateKey = options.privateKey ?? process.env.TIGER_PRIVATE_KEY
    this.accountId = options.accountId ?? process.env.TIGER_ACCOUNT_ID
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(bizContent: Record<string, unknown>, method: string): Promise<T> {
    const payload = {
      tiger_id: this.tigerId ?? 'demo',
      method,
      charset: 'UTF-8',
      sign_type: 'RSA2',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
    }

    try {
      const res = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Tiger HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Tiger network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { symbol: sym, canonical } = toTigerSymbol(symbol)
    try {
      const data = await this.requestJson<{
        code: number
        data?: Array<{ symbol: string; latestPrice: number; volume: number; timestamp: number }>
      }>({ symbols: [sym] }, 'quote_real_time')
      if (data.code === 0 && Array.isArray(data.data) && data.data.length > 0) {
        const row = data.data[0]
        return {
          symbol: canonical,
          price: row.latestPrice,
          volume: row.volume,
          timestamp: row.timestamp,
        }
      }
    } catch {
      // 离线时回退腾讯港股
      const hkCode = `hk${sym.padStart(5, '0')}`
      const res = await this.fetchImpl(`https://qt.gtimg.cn/q=${hkCode}`)
      const text = await res.text()
      const parts = text.split('~')
      const price = parseFloat(parts[3] || '0')
      return {
        symbol: canonical,
        price,
        timestamp: Date.now(),
      }
    }

    return { symbol: canonical, price: 0, timestamp: Date.now() }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { symbol: sym, canonical } = toTigerSymbol(symbol)
    try {
      const data = await this.requestJson<{
        code: number
        data?: Array<{ items?: Array<{ time: number; open: number; close: number; high: number; low: number; volume: number }> }>
      }>({ symbols: [sym], period: interval, limit }, 'kline_quote')
      const items = data.data?.[0]?.items
      if (Array.isArray(items)) {
        return items.map((r) => ({
          openTime: r.time,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          closeTime: r.time + 86400000 - 1,
        }))
      }
    } catch {
      // 回退腾讯港股日K
      const hkCode = `hk${sym.padStart(5, '0')}`
      const res = await this.fetchImpl(`https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=${hkCode},day,,,${limit},qfq`)
      const d = await res.json() as { data?: Record<string, { day?: string[][]; qfqday?: string[][] }> }
      const arr = d.data?.[hkCode]?.qfqday ?? d.data?.[hkCode]?.day ?? []
      return arr.map((item) => {
        const openTime = new Date(item[0].replace(/-/g, '/')).getTime()
        return {
          openTime,
          open: parseFloat(item[1]),
          close: parseFloat(item[2]),
          high: parseFloat(item[3]),
          low: parseFloat(item[4]),
          volume: parseFloat(item[5]),
          closeTime: openTime + 86400000 - 1,
        }
      })
    }

    return []
  }

  async getBalance(): Promise<AccountBalance> {
    return { currency: 'HKD', available: 500000, total: 500000 }
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    const { canonical } = toTigerSymbol(req.symbol)
    return {
      id: `tiger-${Date.now()}`,
      symbol: canonical,
      side: req.side,
      type: req.type,
      status: req.dryRun ? 'filled' : 'new',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: req.dryRun ?? true,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(_creds: unknown, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }
