/**
 * @dshtrading/connector-xysz/rest
 * 银河星耀数智（AmazingData / tgw）A 股数据 REST 客户端。
 *
 * 上游是本机/局域网的 FastAPI 封装服务（见 xysz-api），它把 AmazingData Python SDK
 * 的查询接口包成 HTTP JSON。本客户端只做形态归一、周期映射与错误映射，不直连 SDK。
 */

import type {
  Interval,
  Kline,
  Orderbook,
  OrderbookLevel,
  StockFundamentals,
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

/** dsh-trading 规范 interval 词汇（星耀数智上游覆盖 A 股全部周期）。 */
export const INTERVAL_VOCABULARY = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '1d', '1w', '1M'] as const

/** 星耀数智上游支持的周期（与 xysz-api 的 _INTERVAL_TO_PERIOD 一一对应）。 */
export function assertSupportedInterval(interval: Interval): void {
  if (!(INTERVAL_VOCABULARY as readonly string[]).includes(interval)) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_INTERVAL',
      'Xysz upstream does not serve interval "' + interval + '"; supported: ' + INTERVAL_VOCABULARY.join(', '),
    )
  }
}

export interface XyszSymbol {
  /** A 股规范形（docs/symbol-vocabulary.md：NNNNNN.SH / NNNNNN.SZ / NNNNNN.BJ）。 */
  readonly canonical: string
  readonly code: string
  readonly exchange: 'SH' | 'SZ' | 'BJ'
}

const EXCHANGE_BY_PREFIX: ReadonlyArray<[RegExp, 'SH' | 'SZ' | 'BJ']> = [
  [/^(6|9)/, 'SH'],
  [/^(0|2|3)/, 'SZ'],
  [/^(4|8)/, 'BJ'],
]

/**
 * A 股符号归一：接受规范形 600519.SH、裸 6 位 600519、带市场前缀形
 * sh600519 / 600519.sh；港股、加密等跨市场形态显式拒绝（fail-closed）。
 */
export function toXyszSymbol(symbol: string): XyszSymbol {
  const clean = symbol.trim().toUpperCase()
  if (clean === '') {
    throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'Xysz: empty symbol')
  }
  // 跨市场形态显式拒绝——绝不把港股/加密符号当 A 股查询。
  if (/\.HK$/.test(clean) || /^HK\.?\d/.test(clean) || /(USDT|BTC|ETH)$/.test(clean)) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      'Xysz cn: ' + JSON.stringify(symbol) + ' is not an A-share symbol (this connector serves cn/A-share only)',
    )
  }

  const dotted = /^(\d{6})\.(SH|SZ|BJ)$/.exec(clean)
  if (dotted) {
    const code = dotted[1] as string
    const exchange = dotted[2] as 'SH' | 'SZ' | 'BJ'
    return { canonical: code + '.' + exchange, code, exchange }
  }
  const bare = /^(\d{6})$/.exec(clean)
  if (bare) {
    const code = bare[1] as string
    const matched = EXCHANGE_BY_PREFIX.find(([re]) => re.test(code))
    const exchange = matched !== undefined ? matched[1] : 'SZ'
    return { canonical: code + '.' + exchange, code, exchange }
  }
  const prefixed = /^(SH|SZ|BJ)\.?(\d{6})$/.exec(clean)
  if (prefixed) {
    const code = prefixed[2] as string
    const exchange = prefixed[1] as 'SH' | 'SZ' | 'BJ'
    return { canonical: code + '.' + exchange, code, exchange }
  }
  throw new TradingServiceError(
    'TRADING_UNSUPPORTED_SYMBOL',
    'Xysz cn: malformed A-share symbol ' + JSON.stringify(symbol)
      + ' — expected NNNNNN.SH / NNNNNN.SZ / NNNNNN.BJ, a bare 6-digit code, or sh600519',
  )
}

export interface XyszRestOptions {
  /** 星耀数智 FastAPI 封装服务基址（缺省读 XYSZ_API_URL，再缺省回本机隧道端口）。 */
  apiUrl?: string
  fetchImpl?: typeof fetch
  /** 单次请求超时（ms）。 */
  timeoutMs?: number
}

/** 上游响应形状（只声明我们消费的字段）。 */
interface KlineRow {
  openTime: number
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  amount?: number | null
}

interface KlinePayload {
  symbol: string
  interval: string
  count: number
  klines: KlineRow[]
}

interface TickerPayload {
  symbol: string
  price: number | null
  volume?: number | null
  timestamp: number
  prevClose?: number | null
  changePercent?: number | null
  bid?: number | null
  ask?: number | null
  high?: number | null
  low?: number | null
  open?: number | null
}

interface OrderbookPayload {
  symbol: string
  bids: Array<{ price: number | null; amount: number | null }>
  asks: Array<{ price: number | null; amount: number | null }>
  timestamp: number
}

interface InstrumentsPayload {
  security_type: string
  count: number
  items: Array<{ symbol: string; name?: string }>
}

interface FundamentalsPayload {
  symbol: string
  name?: string
  listPlate?: string
  listDate?: string
  fiftyTwoWeekHigh?: number
  fiftyTwoWeekLow?: number
  timestamp: number
}

export class XyszRestClient {
  readonly apiUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: XyszRestOptions = {}) {
    this.apiUrl = (options.apiUrl ?? process.env.XYSZ_API_URL ?? 'http://127.0.0.1:8191').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 60_000
  }

  private async requestJson<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value))
    }
    const url = this.apiUrl + path + (search.size > 0 ? '?' + search.toString() : '')
    let res: Response
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (err) {
      throw new TradingServiceError(
        'TRADING_NETWORK',
        'Xysz upstream unreachable at ' + this.apiUrl + ': ' + (err instanceof Error ? err.message : String(err)),
        err,
      )
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const detail = body.slice(0, 400)
      // 400 = 参数问题（不支持的符号/周期）；5xx = 上游 SDK 故障。
      if (res.status === 400) {
        throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', 'Xysz upstream rejected the request: ' + detail)
      }
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        'Xysz upstream HTTP ' + res.status + ' for ' + path + ': ' + detail,
      )
    }
    try {
      return await res.json() as T
    } catch (err) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Xysz upstream returned non-JSON for ' + path, err)
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { canonical } = toXyszSymbol(symbol)
    const data = await this.requestJson<TickerPayload>('/api/v1/ticker', { symbol: canonical })
    const price = typeof data.price === 'number' && Number.isFinite(data.price) ? data.price : 0
    // Ticker 字段是 readonly：用可变中间对象收集可选字段，再一次性返回（不逐字段改写）。
    const optional: Partial<Record<'volume' | 'prevClose' | 'changePercent' | 'bid' | 'ask', number>> = {}
    const fields: Array<[keyof TickerPayload, keyof typeof optional]> = [
      ['volume', 'volume'], ['prevClose', 'prevClose'], ['changePercent', 'changePercent'],
      ['bid', 'bid'], ['ask', 'ask'],
    ]
    for (const [src, dst] of fields) {
      const value = data[src]
      if (typeof value === 'number' && Number.isFinite(value)) optional[dst] = value
    }
    return {
      symbol: canonical,
      price,
      timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
      ...optional,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    assertSupportedInterval(interval)
    const { canonical } = toXyszSymbol(symbol)
    const data = await this.requestJson<KlinePayload>('/api/v1/klines', { symbol: canonical, interval, limit })
    const rows = Array.isArray(data.klines) ? data.klines : []
    const klines: Kline[] = []
    for (const row of rows) {
      if (typeof row.openTime !== 'number' || typeof row.open !== 'number' || typeof row.high !== 'number'
        || typeof row.low !== 'number' || typeof row.close !== 'number') {
        continue
      }
      klines.push({
        openTime: row.openTime,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: typeof row.volume === 'number' ? row.volume : 0,
        closeTime: row.openTime,
      })
    }
    return klines
  }

  async getOrderbook(symbol: string): Promise<Orderbook> {
    const { canonical } = toXyszSymbol(symbol)
    const data = await this.requestJson<OrderbookPayload>('/api/v1/orderbook', { symbol: canonical })
    const levels = (rows: Array<{ price: number | null; amount: number | null }> | undefined): OrderbookLevel[] =>
      (rows ?? [])
        .filter((r) => typeof r.price === 'number' && r.price > 0)
        .map((r) => ({ price: r.price as number, amount: typeof r.amount === 'number' ? r.amount : 0 }))
    return {
      symbol: canonical,
      bids: levels(data.bids),
      asks: levels(data.asks),
      timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
    }
  }

  async listInstruments(query?: string): Promise<Array<{ symbol: string; name?: string }>> {
    const data = await this.requestJson<InstrumentsPayload>('/api/v1/instruments', {
      security_type: 'EXTRA_STOCK_A',
      with_names: true,
    })
    const items = Array.isArray(data.items) ? data.items : []
    // 名称过滤在客户端做（上游是全量名册，约 5.5k 行）。
    if (query === undefined || query.trim() === '') return items
    const needle = query.trim().toUpperCase()
    return items.filter((it) =>
      it.symbol.toUpperCase().includes(needle)
      || (it.name ?? '').toUpperCase().includes(needle),
    )
  }

  async getFundamentals(symbol: string): Promise<StockFundamentals> {
    const { canonical } = toXyszSymbol(symbol)
    const data = await this.requestJson<FundamentalsPayload>('/api/v1/fundamentals', { symbol: canonical })
    // StockFundamentals 字段是 readonly：按字段类型分别收集，再一次性展开返回。
    const name = typeof data.name === 'string' && data.name !== '' ? data.name : undefined
    const high = typeof data.fiftyTwoWeekHigh === 'number' ? data.fiftyTwoWeekHigh : undefined
    const low = typeof data.fiftyTwoWeekLow === 'number' ? data.fiftyTwoWeekLow : undefined
    return {
      symbol: canonical,
      timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
      ...(name !== undefined ? { name } : {}),
      ...(high !== undefined ? { fiftyTwoWeekHigh: high } : {}),
      ...(low !== undefined ? { fiftyTwoWeekLow: low } : {}),
    }
  }
}

export type { Interval, Kline, Orderbook, StockFundamentals, Ticker }
