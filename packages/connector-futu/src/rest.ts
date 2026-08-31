/**
 * Futu (富途 OpenD) REST 客户端 —— 港股市场 (hk) 行情与交易数据面。
 *
 * 通过本地或远程 FutuOpenD 网关进行交互（默认 http://127.0.0.1:11111）。
 *
 * @module @dsh-trading/connector-futu/rest
 */

import type {
  AccountBalance,
  Interval,
  Kline,
  Order,
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

export interface FutuRestOptions {
  gatewayUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface FutuCredentials {
  readonly unlockPwd?: string
}

/** 富途 K 线周期映射枚举 */
export const INTERVAL_TO_FUTU: Record<Interval, number> = {
  '1m': 1,
  '5m': 2,
  '15m': 3,
  '30m': 4,
  '1h': 5,
  '4h': 5, // Futu 无 4h 原生档，映射到 60m
  '1d': 6,
  '1w': 7,
  '1M': 8,
}

const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 1000,
  '1M': 30 * 24 * 60 * 1000,
}

export const INTERVAL_VOCABULARY = Object.keys(INTERVAL_TO_FUTU) as Interval[]

/** 归一化港股代码为规范形（如 00700.HK） */
export function normalizeHkSymbol(raw: string): string {
  const trimmed = raw.trim().toUpperCase()
  let code = trimmed
  if (code.startsWith('HK.')) code = code.slice(3)
  if (code.endsWith('.HK')) code = code.slice(0, -3)
  if (/^\d{1,5}$/.test(code)) {
    return `${code.padStart(5, '0')}.HK`
  }
  throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Futu: malformed HK symbol ${JSON.stringify(raw)}`)
}

/** 将规范形转换为 FutuOpenD 所需格式（HK.00700） */
export function toFutuSecurity(canonicalSymbol: string): string {
  const norm = normalizeHkSymbol(canonicalSymbol)
  const digits = norm.slice(0, 5)
  return `HK.${digits}`
}

export class FutuRestClient {
  private readonly gatewayUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: FutuRestOptions = {}) {
    this.gatewayUrl = (options.gatewayUrl ?? 'http://127.0.0.1:11111').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  private async request<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    const url = new URL(path.startsWith('/') ? path : '/' + path, this.gatewayUrl)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url.toString(), {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `FutuOpenD HTTP ${res.status}: ${res.statusText}`)
      }
      const data = await res.json() as { retType?: number; retMsg?: string; sErr?: string; data?: unknown }
      if (typeof data === 'object' && data !== null && 'retType' in data && data.retType !== 0) {
        const msg = data.retMsg || data.sErr || 'unknown error'
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `FutuOpenD error (${data.retType}): ${msg}`)
      }
      return (data?.data ?? data) as T
    } catch (error) {
      if (error instanceof TradingServiceError) throw error
      const msg = error instanceof Error ? error.message : String(error)
      if (/ECONNREFUSED|fetch failed|failed to fetch/i.test(msg)) {
        throw new TradingServiceError(
          'TRADING_NETWORK',
          `FutuOpenD gateway is not reachable at ${this.gatewayUrl}. Please ensure FutuOpenD is running and listening on this port.`,
          error,
        )
      }
      throw new TradingServiceError('TRADING_NETWORK', msg, error)
    } finally {
      clearTimeout(timer)
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const canonical = normalizeHkSymbol(symbol)
    const security = toFutuSecurity(canonical)
    const data = await this.request<{
      curPrice?: number
      price?: number
      bidPrice?: number
      askPrice?: number
      volume?: number
      time?: string | number
    }>('/api/qot/get-ticker', { security })

    const price = Number(data.curPrice ?? data.price ?? 0)
    const bid = typeof data.bidPrice === 'number' && data.bidPrice > 0 ? data.bidPrice : undefined
    const ask = typeof data.askPrice === 'number' && data.askPrice > 0 ? data.askPrice : undefined
    const volume = typeof data.volume === 'number' ? data.volume : undefined
    const timestamp = typeof data.time === 'number'
      ? data.time
      : typeof data.time === 'string' ? new Date(data.time).getTime() : Date.now()

    return {
      symbol: canonical,
      price,
      timestamp,
      ...(bid !== undefined ? { bid } : {}),
      ...(ask !== undefined ? { ask } : {}),
      ...(volume !== undefined ? { volume } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval, limit = 100): Promise<Kline[]> {
    const canonical = normalizeHkSymbol(symbol)
    const security = toFutuSecurity(canonical)
    const klType = INTERVAL_TO_FUTU[interval]
    if (!klType) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_INTERVAL', `Futu: unsupported interval ${String(interval)}`)
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000)
    const data = await this.request<{
      klList?: Array<{ time: string | number; open: number; high: number; low: number; close: number; volume: number }>
      bars?: Array<{ time: string | number; open: number; high: number; low: number; close: number; volume: number }>
    }>('/api/qot/get-kl', {
      security,
      klType,
      reqNum: safeLimit,
      rehabType: 1, // 前复权
    })

    const rawList = data.klList ?? data.bars ?? []
    const duration = INTERVAL_MS[interval] ?? 24 * 60 * 60 * 1000

    return rawList.map((row) => {
      const openTime = typeof row.time === 'number' ? row.time : new Date(row.time).getTime()
      return {
        openTime,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        closeTime: openTime + duration - 1,
      }
    })
  }

  async listInstruments(): Promise<Array<{ symbol: string; name?: string }>> {
    try {
      const data = await this.request<{
        securityList?: Array<{ security: string; name?: string }>
      }>('/api/qot/get-plate-security', { plate: 'HK.BK1000' })
      const list = data.securityList ?? []
      return list.map((item) => ({
        symbol: normalizeHkSymbol(item.security),
        ...(item.name ? { name: item.name } : {}),
      }))
    } catch {
      return []
    }
  }

  async getBalance(_credentials?: FutuCredentials): Promise<AccountBalance> {
    const data = await this.request<{ cash?: number; totalAssets?: number; currency?: string }>('/api/trd/get-funds')
    return {
      currency: data.currency ?? 'HKD',
      available: Number(data.cash ?? 0),
      total: Number(data.totalAssets ?? 0),
    }
  }

  async placeOrder(_credentials: FutuCredentials | undefined, req: { symbol: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT'; quantity: number; price?: number }): Promise<Order> {
    const canonical = normalizeHkSymbol(req.symbol)
    const security = toFutuSecurity(canonical)
    const data = await this.request<{ orderId?: string; orderID?: string }>('/api/trd/place-order', {
      security,
      trdSide: req.side === 'BUY' ? 1 : 2,
      orderType: req.type === 'MARKET' ? 2 : 1,
      qty: req.quantity,
      price: req.price ?? 0,
    })

    const id = data.orderId ?? data.orderID ?? `futu-${Date.now()}`
    return {
      id,
      symbol: canonical,
      side: req.side,
      type: req.type,
      quantity: req.quantity,
      price: req.price,
      status: 'new',
      timestamp: Date.now(),
    }
  }

  async cancelOrder(_credentials: FutuCredentials | undefined, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    await this.request('/api/trd/cancel-order', { orderId })
    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }

