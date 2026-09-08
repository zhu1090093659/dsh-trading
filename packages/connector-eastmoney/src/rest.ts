/**
 * @dshtrading/connector-eastmoney/rest
 * 东方财富 A 股公开 REST 行情客户端（免密公共源）。
 */

import type {
  Interval,
  Kline,
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
 * 上游分精度整数（×100，如昨收 f60=129740 → 1297.40）→ 数值；
 * '-'/‘−’ 停牌占位或缺失返回 undefined。
 */
function parseScaled(value: unknown, scale: number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value / scale : undefined
  if (typeof value === 'string' && value !== '-' && value !== '−') {
    const parsed = parseFloat(value)
    return Number.isNaN(parsed) ? undefined : parsed / scale
  }
  return undefined
}

function parseScaledHundred(value: unknown): number | undefined {
  return parseScaled(value, 100)
}

const KNOWN_SH_INDICES = new Set(['000688', '000300', '000016', '000905', '000852'])

/** 连接器服务的市场（cn=A 股；hk=港股，2026-09-08 扩展，实证见 spikes/impl-eastmoney-hk/）。 */
export type EastmoneyMarket = 'cn' | 'hk'

/** CN/HK 均为永久 UTC+8（无夏令时）——墙钟时间用固定偏移锚定，与运行机器时区无关。 */
const UTC8_MS = 8 * 3600_000

/** `YYYY-MM-DD HH:MM[:SS]`（UTC+8 墙钟）→ epoch ms。 */
export function utc8WallTimeToEpochMs(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid eastmoney wall time ${JSON.stringify(value)}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) - UTC8_MS
}

/** 东财价格字段的分精度倍率：cn ×100（2 位小数），hk ×1000（3 位小数，响应 decimal=3）。 */
export function eastmoneyPriceScale(market: EastmoneyMarket): number {
  return market === 'hk' ? 1000 : 100
}

/**
 * 将标准代码（如 600519.SH / 000001.SZ / 600519 / 000001）转为东财 secid。
 * 上海（60/68/51等）= 1.xxxxxx
 * 深圳（00/30/15等）= 0.xxxxxx
 * 北京（83/87/43/92等）= 0.xxxxxx
 */
export function toEastmoneySecid(symbol: string): { secid: string; canonical: string; market: EastmoneyMarket } {
  const clean = symbol.trim().toUpperCase()
  // 港股分支：`00700.HK` / `HK00700` / 裸 5 位数字（A 股代码恒 6 位，无歧义）→ secid 116.xxxxx。
  const hkMatch = /^(\d{1,5})\.HK$/.exec(clean) ?? /^HK(\d{1,5})$/.exec(clean)
  if (hkMatch !== null || /^\d{5}$/.test(clean)) {
    const hkCode = (hkMatch?.[1] ?? clean).padStart(5, '0')
    return { secid: `116.${hkCode}`, canonical: `${hkCode}.HK`, market: 'hk' }
  }
  let code = clean
  let market = ''

  if (clean.includes('.')) {
    const parts = clean.split('.')
    code = parts[0]
    market = parts[1]
  } else if (/^\d{6}$/.test(clean)) {
    code = clean
    if (KNOWN_SH_INDICES.has(code) || code.startsWith('6') || code.startsWith('5') || code.startsWith('9')) {
      market = 'SH'
    } else if (code.startsWith('0') || code.startsWith('3') || code.startsWith('1')) {
      market = 'SZ'
    } else if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) {
      market = 'BJ'
    }
  }

  if (!market) {
    if (KNOWN_SH_INDICES.has(code) || code.startsWith('6') || code.startsWith('5')) market = 'SH'
    else market = 'SZ'
  }

  const prefix = market === 'SH' ? '1' : '0'
  return {
    secid: `${prefix}.${code}`,
    canonical: `${code}.${market}`,
    market: 'cn',
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
    const { secid, canonical, market } = toEastmoneySecid(symbol)
    const scale = eastmoneyPriceScale(market)
    // f60=昨收 f169=涨跌额 f170=涨跌幅（均为 ×100 分精度整数；'-' 停牌占位）。
    const url = `${this.baseUrl}/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170`
    const res = await this.requestJson<{ data?: Record<string, unknown> }>(url)

    if (!res.data) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Eastmoney symbol not found: ${symbol}`)
    }

    const d = res.data
    let rawPrice = 0
    if (typeof d.f43 === 'number') {
      rawPrice = d.f43 / scale
    } else if (typeof d.f43 === 'string' && d.f43 !== '-' && d.f43 !== '−') {
      const parsed = parseFloat(d.f43)
      rawPrice = Number.isNaN(parsed) ? 0 : parsed / scale
    }
    const price = rawPrice > 0 ? rawPrice : 0
    const volume = typeof d.f47 === 'number' ? d.f47 : typeof d.f47 === 'string' ? parseFloat(d.f47) : 0
    const timestamp = typeof d.f86 === 'number' ? d.f86 * 1000 : Date.now()
    // 官方昨收锚点（与 tencent fields[4] 同语义）：涨跌幅基准，UI 头部/侧栏直接消费。
    // hk 昨收同样 ×1000（f60=438400 → 438.4）；涨跌幅 f170 两市场均 ×100。
    const prevClose = market === 'hk' ? parseScaled(d.f60, scale) : parseScaledHundred(d.f60)
    const changePercent = parseScaledHundred(d.f170)

    const name = typeof d.f58 === 'string' && d.f58.trim() ? d.f58.trim() : undefined

    return {
      symbol: canonical,
      ...(name ? { name } : {}),
      price,
      volume: volume > 0 ? volume : 0,
      timestamp,
      ...(prevClose !== undefined && prevClose > 0 ? { prevClose } : {}),
      ...(changePercent !== undefined ? { changePercent } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { secid, market } = toEastmoneySecid(symbol)
    // 港股 1m 走 trends2 分时端点（当日完整分钟序列；kline/get 的 klt=1 对 hk 未实证，
    // 5m/日 K 已实证可用，spikes/impl-eastmoney-hk/）。
    if (market === 'hk' && interval === '1m') {
      return this.getHkIntradayTrends(secid, limit)
    }
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

  /**
   * 港股当日分时（trends2，ndays=1 = 最近一个交易日全天分钟序列，非交易日自然回落）。
   * 行格式同 kline/get：`时间,开,收,高,低,量,额,均价`；时间 'YYYY-MM-DD HH:MM' 为 UTC+8 墙钟。
   */
  private async getHkIntradayTrends(secid: string, limit: number): Promise<Kline[]> {
    const url = `${this.historyBaseUrl}/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0`
    const res = await this.requestJson<{ data?: { trends?: string[] } }>(url)
    const trends = res.data?.trends
    if (!Array.isArray(trends)) return []

    const stepMs = parseIntervalMs('1m')
    const klines: Kline[] = []
    for (const line of trends) {
      const parts = line.split(',')
      if (parts.length < 6) continue
      const openTime = utc8WallTimeToEpochMs(parts[0] ?? '')
      klines.push({
        openTime,
        open: parseFloat(parts[1] ?? ''),
        high: parseFloat(parts[3] ?? ''),
        low: parseFloat(parts[4] ?? ''),
        close: parseFloat(parts[2] ?? ''),
        volume: parseFloat(parts[5] ?? ''),
        closeTime: openTime + stepMs - 1,
      })
    }
    return klines.slice(-Math.max(limit, 1))
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
