/**
 * @dsh-trading/connector-akshare/rest
 * AkShare A 股宏观与量化另类数据 REST 客户端。
 */

import type {
  Interval,
  Kline,
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

export function toEastmoneySecid(symbol: string): { secid: string; canonical: string } {
  const clean = symbol.trim().toUpperCase()
  let code = clean
  let market = 'SH'
  if (clean.includes('.')) {
    const parts = clean.split('.')
    code = parts[0]
    market = parts[1]
  } else if (code.startsWith('0') || code.startsWith('3')) {
    market = 'SZ'
  }
  const prefix = market === 'SH' ? '1' : '0'
  return { secid: `${prefix}.${code}`, canonical: `${code}.${market}` }
}

export interface AkshareRestOptions {
  apiUrl?: string
  fetchImpl?: typeof fetch
}

export class AkshareRestClient {
  readonly apiUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: AkshareRestOptions = {}) {
    this.apiUrl = options.apiUrl ?? (process.env.AKSHARE_API_URL || 'http://127.0.0.1:8080')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(url: string): Promise<T> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Akshare HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Akshare network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { secid, canonical } = toEastmoneySecid(symbol)
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f47,f86`
    const res = await this.requestJson<{ data?: { f43?: number; f47?: number; f86?: number } }>(url)
    if (!res.data) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `AkShare/Eastmoney quote not found: ${symbol}`)
    }
    const rawPrice = typeof res.data.f43 === 'number' ? res.data.f43 / 100 : 0
    return {
      symbol: canonical,
      price: rawPrice > 0 ? rawPrice : 0,
      volume: res.data.f47 ?? 0,
      timestamp: res.data.f86 ? res.data.f86 * 1000 : Date.now(),
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { secid } = toEastmoneySecid(symbol)
    const klt = interval === '5m' ? '5' : interval === '15m' ? '15' : interval === '30m' ? '30' : interval === '1h' ? '60' : '101'
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}&fields2=f51,f52,f53,f54,f55,f56`
    const res = await this.requestJson<{ data?: { klines?: string[] } }>(url)
    if (!res.data?.klines) return []

    return res.data.klines.map((line) => {
      const parts = line.split(',')
      const openTime = new Date(parts[0].replace(/-/g, '/')).getTime()
      return {
        openTime,
        open: parseFloat(parts[1]),
        close: parseFloat(parts[2]),
        high: parseFloat(parts[3]),
        low: parseFloat(parts[4]),
        volume: parseFloat(parts[5]),
        closeTime: openTime + 86400000 - 1,
      }
    })
  }

  async getSectorFundFlow(): Promise<Array<{ name: string; changePercent: number; mainNetInflow: number }>> {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fields=f12,f14,f3,f62&fs=m:90+t:2'
    const res = await this.requestJson<{ data?: { diff?: Array<{ f14: string; f3: number; f62: number }> } }>(url)
    const list = res.data?.diff ?? []
    return list.map((item) => ({
      name: item.f14,
      changePercent: typeof item.f3 === 'number' ? item.f3 / 100 : 0,
      mainNetInflow: item.f62,
    }))
  }
}

export type { Interval, Kline, Ticker }
