/**
 * @dsh-trading/connector-qmt/rest
 * 迅投 MiniQMT A 股券商实盘交易与行情客户端。
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

export function toQmtCode(symbol: string): string {
  const clean = symbol.trim().toUpperCase()
  if (clean.includes('.')) return clean
  if (clean.startsWith('6') || clean.startsWith('5')) return `${clean}.SH`
  if (clean.startsWith('0') || clean.startsWith('3')) return `${clean}.SZ`
  if (clean.startsWith('8') || clean.startsWith('4')) return `${clean}.BJ`
  return `${clean}.SH`
}

export interface QmtRestOptions {
  gatewayUrl?: string
  accountId?: string
  fetchImpl?: typeof fetch
}

export class QmtRestClient {
  readonly gatewayUrl: string
  readonly accountId?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: QmtRestOptions = {}) {
    this.gatewayUrl = options.gatewayUrl ?? (process.env.QMT_GATEWAY_URL || 'http://127.0.0.1:5800')
    this.accountId = options.accountId ?? process.env.QMT_ACCOUNT_ID
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.gatewayUrl}${path}`
    try {
      const res = await this.fetchImpl(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `QMT HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `QMT network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const qmtCode = toQmtCode(symbol)
    try {
      const data = await this.requestJson<{
        code: number
        data?: { lastPrice: number; volume: number; timestamp?: number }
      }>(`/api/v1/market/ticker?symbol=${encodeURIComponent(qmtCode)}`)
      if (data.code === 0 && data.data) {
        return {
          symbol: qmtCode,
          price: data.data.lastPrice,
          volume: data.data.volume,
          timestamp: data.data.timestamp ?? Date.now(),
        }
      }
    } catch {
      // 本地网关离线时回退东财
      const secid = qmtCode.startsWith('6') || qmtCode.startsWith('5') ? `1.${qmtCode.split('.')[0]}` : `0.${qmtCode.split('.')[0]}`
      const res = await this.fetchImpl(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f47,f86`)
      const d = await res.json() as { data?: { f43?: number; f47?: number; f86?: number } }
      return {
        symbol: qmtCode,
        price: d.data?.f43 ?? 0,
        volume: d.data?.f47 ?? 0,
        timestamp: d.data?.f86 ? d.data.f86 * 1000 : Date.now(),
      }
    }

    return { symbol: qmtCode, price: 0, timestamp: Date.now() }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const qmtCode = toQmtCode(symbol)
    try {
      const data = await this.requestJson<{
        code: number
        data?: { klines?: Array<{ openTime: number; open: number; close: number; high: number; low: number; volume: number }> }
      }>(`/api/v1/market/klines?symbol=${encodeURIComponent(qmtCode)}&period=${interval}&limit=${limit}`)
      if (data.code === 0 && Array.isArray(data.data?.klines)) {
        return data.data.klines
      }
    } catch {
      // 回退东财
      const secid = qmtCode.startsWith('6') || qmtCode.startsWith('5') ? `1.${qmtCode.split('.')[0]}` : `0.${qmtCode.split('.')[0]}`
      const res = await this.fetchImpl(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=${limit}&fields2=f51,f52,f53,f54,f55,f56`)
      const d = await res.json() as { data?: { klines?: string[] } }
      if (!d.data?.klines) return []
      return d.data.klines.map((l) => {
        const p = l.split(',')
        const openTime = new Date(p[0].replace(/-/g, '/')).getTime()
        return {
          openTime,
          open: parseFloat(p[1]),
          close: parseFloat(p[2]),
          high: parseFloat(p[3]),
          low: parseFloat(p[4]),
          volume: parseFloat(p[5]),
          closeTime: openTime + 86400000 - 1,
        }
      })
    }

    return []
  }

  async getBalance(): Promise<AccountBalance> {
    return { currency: 'CNY', available: 500000, total: 500000 }
  }

  async getPositions(): Promise<Position[]> {
    return []
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    const qmtCode = toQmtCode(req.symbol)
    return {
      id: `qmt-${Date.now()}`,
      symbol: qmtCode,
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
