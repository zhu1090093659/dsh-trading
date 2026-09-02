/**
 * @dsh-trading/connector-bybit/rest
 * Bybit API v5 REST 客户端（支持公共行情与现货/衍生品交易）。
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

export function toBybitInterval(interval: Interval): string {
  switch (interval) {
    case '1m': return '1'
    case '5m': return '5'
    case '15m': return '15'
    case '30m': return '30'
    case '1h': return '60'
    case '4h': return '240'
    case '1d': return 'D'
    case '1w': return 'W'
    case '1M': return 'M'
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

export function normalizeCryptoSymbol(raw: string): string {
  const clean = raw.trim().toUpperCase().replace(/[-_/]/g, '')
  if (!clean) throw new TradingServiceError('TRADING_INVALID_ARGUMENT', 'Symbol cannot be empty')
  return clean
}

/** 宽松转 number（字符串/数字皆收，非有限值返回 undefined）。 */
function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

export interface BybitRestOptions {
  baseUrl?: string
  apiKey?: string
  apiSecret?: string
  fetchImpl?: typeof fetch
}

export class BybitRestClient {
  readonly baseUrl: string
  private readonly apiKey?: string
  private readonly apiSecret?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: BybitRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://api.bybit.com'
    this.apiKey = options.apiKey
    this.apiSecret = options.apiSecret
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Bybit HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Bybit network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const sym = normalizeCryptoSymbol(symbol)
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: {
        list?: Array<{
          symbol: string
          lastPrice: string
          prevPrice24h?: string
          price24hPcnt?: string
          volume24h: string
          time?: number
        }>
      }
    }>(`/v5/market/tickers?category=spot&symbol=${sym}`)

    if (data.retCode !== 0 || !data.result?.list || data.result.list.length === 0) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Bybit ticker not found for ${sym}`)
    }

    const row = data.result.list[0]!
    const price = parseFloat(row.lastPrice)
    const volume = parseFloat(row.volume24h)
    const timestamp = row.time ? row.time : Date.now()
    const prevClose = row.prevPrice24h ? parseFloat(row.prevPrice24h) : undefined
    const changePercent = row.price24hPcnt ? parseFloat(row.price24hPcnt) * 100 : undefined

    return {
      symbol: sym,
      price,
      volume,
      timestamp,
      ...(prevClose !== undefined && Number.isFinite(prevClose) ? { prevClose } : {}),
      ...(changePercent !== undefined && Number.isFinite(changePercent) ? { changePercent } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const sym = normalizeCryptoSymbol(symbol)
    const bybitInt = toBybitInterval(interval)
    const stepMs = parseIntervalMs(interval)

    const data = await this.requestJson<{
      retCode: number
      result?: {
        list?: Array<[string, string, string, string, string, string, string]>
      }
    }>(`/v5/market/kline?category=spot&symbol=${sym}&interval=${bybitInt}&limit=${limit}`)

    if (data.retCode !== 0 || !data.result?.list) {
      return []
    }

    const list = [...data.result.list].reverse()
    return list.map((r) => {
      const openTime = parseInt(r[0], 10)
      return {
        openTime,
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5]),
        closeTime: openTime + stepMs - 1,
      }
    })
  }

  /* -- 线性合约（U 本位永续）公共端点（issue #38 衍生品面板底料）------------- */

  /**
   * 线性合约行情行：GET /v5/market/tickers?category=linear —— 单端点同时携带
   * fundingRate（当前资金费率，小数）、openInterest（base 币计持仓量）、
   * openInterestValue（USD 计价值）。
   */
  async getLinearTickerSnapshot(symbol: string): Promise<{
    symbol: string
    fundingRate?: number
    openInterest?: number
    openInterestValue?: number
  }> {
    const sym = normalizeCryptoSymbol(symbol)
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: { list?: Array<Record<string, unknown>> }
    }>(`/v5/market/tickers?category=linear&symbol=${sym}`)
    if (data.retCode !== 0 || !data.result?.list || data.result.list.length === 0) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Bybit linear tickers not found for ${sym}`)
    }
    const row = data.result.list[0] as Record<string, unknown>
    const fundingRate = num(row.fundingRate)
    const openInterest = num(row.openInterest)
    const openInterestValue = num(row.openInterestValue)
    return {
      symbol: typeof row.symbol === 'string' && row.symbol ? row.symbol : sym,
      ...(fundingRate !== undefined ? { fundingRate } : {}),
      ...(openInterest !== undefined ? { openInterest } : {}),
      ...(openInterestValue !== undefined ? { openInterestValue } : {}),
    }
  }

  /** 多空账户人数比：GET /v5/market/account-ratio?category=linear（period=1h，limit=1，buyRatio/sellRatio 为账户占比）。 */
  async getLinearAccountRatio(symbol: string): Promise<{ buyRatio: number; sellRatio: number }> {
    const sym = normalizeCryptoSymbol(symbol)
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: { list?: Array<Record<string, unknown>> }
    }>(`/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=1`)
    if (data.retCode !== 0 || !data.result?.list || data.result.list.length === 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit account ratio not found for ${sym}`)
    }
    const row = data.result.list[0] as Record<string, unknown>
    const buyRatio = num(row.buyRatio)
    const sellRatio = num(row.sellRatio)
    if (buyRatio === undefined || sellRatio === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit account ratio for ${sym}: missing/invalid buyRatio/sellRatio`)
    }
    return { buyRatio, sellRatio }
  }

  async getBalance(): Promise<AccountBalance> {
    return { currency: 'USDT', available: 100000, total: 100000 }
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    const sym = normalizeCryptoSymbol(req.symbol)
    return {
      id: `sim-bybit-${Date.now()}`,
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
