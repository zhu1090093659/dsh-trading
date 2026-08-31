/**
 * @dsh-trading/connector-eastmoney/rest
 * 东方财富 A 股公开 REST 行情客户端（免密公共源）。
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

export function mapIntervalToKlt(interval: Interval): string {
  switch (interval) {
    case '1m': return '1'
    case '5m': return '5'
    case '15m': return '15'
    case '30m': return '30'
    case '1h': return '60'
    case '1d': return '101'
    case '1w': return '102'
    case '1M': return '103'
    default:
      throw new TradingServiceError(
        'TRADING_INVALID_ARGUMENT',
        `Unsupported interval "${interval}" for Eastmoney. Valid: ${INTERVAL_VOCABULARY.join(', ')}`,
      )
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

/**
 * 将标准代码（如 600519.SH / 000001.SZ / 600519 / 000001）转为东财 secid。
 * 上海（60/68/51等）= 1.xxxxxx
 * 深圳（00/30/15等）= 0.xxxxxx
 * 北京（83/87/43/92等）= 0.xxxxxx
 */
export function toEastmoneySecid(symbol: string): { secid: string; canonical: string } {
  const clean = symbol.trim().toUpperCase()
  let code = clean
  let market = ''

  if (clean.includes('.')) {
    const parts = clean.split('.')
    code = parts[0]
    market = parts[1]
  } else if (/^\d{6}$/.test(clean)) {
    code = clean
    if (code.startsWith('6') || code.startsWith('5') || code.startsWith('9')) {
      market = 'SH'
    } else if (code.startsWith('0') || code.startsWith('3') || code.startsWith('1')) {
      market = 'SZ'
    } else if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) {
      market = 'BJ'
    }
  }

  if (!market) {
    if (code.startsWith('6') || code.startsWith('5')) market = 'SH'
    else market = 'SZ'
  }

  const prefix = market === 'SH' ? '1' : '0'
  return {
    secid: `${prefix}.${code}`,
    canonical: `${code}.${market}`,
  }
}

export interface EastmoneyRestOptions {
  baseUrl?: string
  historyBaseUrl?: string
  searchBaseUrl?: string
  fetchImpl?: typeof fetch
}

export class EastmoneyRestClient {
  readonly baseUrl: string
  readonly historyBaseUrl: string
  readonly searchBaseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: EastmoneyRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://push2.eastmoney.com'
    this.historyBaseUrl = options.historyBaseUrl ?? 'https://push2his.eastmoney.com'
    this.searchBaseUrl = options.searchBaseUrl ?? 'https://searchapi.eastmoney.com'
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(url: string): Promise<T> {
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
          'Referer': 'https://quote.eastmoney.com/',
        },
      })
      if (!res.ok) {
        throw new TradingServiceError(
          'TRADING_UPSTREAM_ERROR',
          `Eastmoney HTTP request failed: status ${res.status} ${res.statusText}`,
        )
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Eastmoney network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { secid, canonical } = toEastmoneySecid(symbol)
    const url = `${this.baseUrl}/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f86,f169,f170`
    const res = await this.requestJson<{ data?: Record<string, unknown> }>(url)

    if (!res.data) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Eastmoney symbol not found: ${symbol}`)
    }

    const d = res.data
    let rawPrice = 0
    if (typeof d.f43 === 'number') {
      rawPrice = d.f43 / 100
    } else if (typeof d.f43 === 'string' && d.f43 !== '-' && d.f43 !== '−') {
      const parsed = parseFloat(d.f43)
      rawPrice = Number.isNaN(parsed) ? 0 : parsed / 100
    }
    const price = rawPrice > 0 ? rawPrice : 0
    const volume = typeof d.f47 === 'number' ? d.f47 : typeof d.f47 === 'string' ? parseFloat(d.f47) : 0
    const timestamp = typeof d.f86 === 'number' ? d.f86 * 1000 : Date.now()

    return {
      symbol: canonical,
      price,
      volume: volume > 0 ? volume : 0,
      timestamp,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { secid } = toEastmoneySecid(symbol)
    const klt = mapIntervalToKlt(interval)
    const stepMs = parseIntervalMs(interval)
    const url = `${this.historyBaseUrl}/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
    
    const res = await this.requestJson<{ data?: { klines?: string[] } }>(url)
    if (!res.data || !Array.isArray(res.data.klines)) {
      return []
    }

    const klines: Kline[] = []
    for (const line of res.data.klines) {
      const parts = line.split(',')
      if (parts.length < 6) continue
      const timeStr = parts[0]
      const open = parseFloat(parts[1])
      const close = parseFloat(parts[2])
      const high = parseFloat(parts[3])
      const low = parseFloat(parts[4])
      const volume = parseFloat(parts[5])

      const openTime = new Date(timeStr.replace(/-/g, '/')).getTime()
      if (Number.isNaN(openTime)) continue

      klines.push({
        openTime,
        open,
        high,
        low,
        close,
        volume,
        closeTime: openTime + stepMs - 1,
      })
    }

    return klines
  }

  async listInstruments(query?: string): Promise<Array<{ symbol: string; name: string }>> {
    if (!query) return []
    const url = `${this.searchBaseUrl}/api/suggest/get?input=${encodeURIComponent(query)}&type=14`
    const res = await this.requestJson<{ QuotationCodeTable?: { Data?: Array<{ Code: string; Name: string; SecurityTypeName: string }> } }>(url)
    const items = res.QuotationCodeTable?.Data ?? []
    return items.map((item) => {
      const { canonical } = toEastmoneySecid(item.Code)
      return { symbol: canonical, name: item.Name }
    })
  }
}
export type { Interval, Kline, Ticker }
