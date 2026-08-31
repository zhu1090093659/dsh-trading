/**
 * Binance 公共 REST 客户端（dsh-trading crypto 切片）。
 *
 * 独立于插件 glue：仅依赖 @dsh-trading/api 的类型词汇，无 cordis/dsh-tools 运行时依赖，
 * 便于单测与脚本直接消费（fetch 可注入）。数据面：api.binance.com 公共 REST（/api/v3），
 * 全局 fetch（Node 22+ 内置），AbortController 10s 超时，零凭证（铁律 #3：公共行情无需 key）。
 *
 * @module @dsh-trading/connector-binance/rest
 */

import type {
  Interval,
  Kline,
  Ticker,
  TradingErrorCode,
} from '@dsh-trading/api'

/* ------------------------------------------------------------------ */
/* 错误载体（api 包词汇的运行时映射）                                      */
/* ------------------------------------------------------------------ */

/** api 包 TradingError 契约的运行时 Error 实现。 */
export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/* ------------------------------------------------------------------ */
/* Binance 公共 REST 客户端（无凭证、可注入 fetch，便于单测）               */
/* ------------------------------------------------------------------ */

const DEFAULT_BASE_URL = 'https://api.binance.com'
const DEFAULT_TIMEOUT_MS = 10_000

export interface BinanceRestOptions {
  /** 覆盖 API base（测试/反代用），末尾不带斜杠。 */
  readonly baseUrl?: string
  /** 单请求超时（ms），默认 10s。 */
  readonly timeoutMs?: number
  /** 注入 fetch 实现；缺省用全局 fetch（Node 22+ 内置）。 */
  readonly fetchImpl?: typeof fetch
}

/** Binance klines 支持的 interval 词汇（与 api 包 Interval 对齐）。 */
const INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
] as const satisfies readonly Interval[]

/** 全量 interval 词汇，供工具 parameters 的 enum 使用。 */
export const INTERVAL_VOCABULARY: readonly string[] = INTERVALS

function isInterval(value: unknown): value is Interval {
  return typeof value === 'string' && (INTERVALS as readonly string[]).includes(value)
}

/** 校验并规范化 symbol（Binance 现货符号为大写无分隔，如 BTCUSDT）。 */
function requireSymbol(symbol: string): string {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      'Symbol must be a non-empty string, e.g. BTCUSDT',
    )
  }
  return symbol.trim().toUpperCase()
}

/** Binance 返回数值均为字符串，宽松转 number（非有限值返回 undefined）。 */
function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

interface BinanceErrorBody {
  readonly code?: unknown
  readonly msg?: unknown
}

/** Binance 错误码 → api 词汇的已知映射（-1121 Invalid symbol / -1120 Invalid period）。 */
const BINANCE_CODE_MAP: ReadonlyMap<number, TradingErrorCode> = new Map([
  [-1121, 'TRADING_UNSUPPORTED_SYMBOL'],
  [-1120, 'TRADING_UNSUPPORTED_INTERVAL'],
])

async function httpToTradingError(res: Response, path: string): Promise<TradingServiceError> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  const err = (body ?? {}) as BinanceErrorBody
  const binanceCode = typeof err.code === 'number' ? err.code : undefined
  const binanceMsg = typeof err.msg === 'string' ? err.msg : ''

  let code: TradingErrorCode
  if (res.status === 429 || res.status === 418) {
    code = 'TRADING_RATE_LIMITED'
  } else if (res.status === 401 || res.status === 403) {
    code = 'TRADING_AUTH_FAILED'
  } else if (binanceCode !== undefined && BINANCE_CODE_MAP.has(binanceCode)) {
    code = BINANCE_CODE_MAP.get(binanceCode)!
  } else {
    code = 'TRADING_EXCHANGE_ERROR'
  }

  const detail = [res.status, binanceCode !== undefined ? `code=${binanceCode}` : undefined, binanceMsg || res.statusText]
    .filter((part) => part !== undefined && part !== '')
    .join(' ')
  return new TradingServiceError(code, `Binance ${path}: ${detail}`)
}

/** K 线响应行：[openTime, open, high, low, close, volume, closeTime, ...]。 */
function parseKlineRow(row: unknown, symbol: string): Kline {
  if (!Array.isArray(row) || row.length < 7) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance klines: malformed row for ${symbol}`)
  }
  const openTime = num(row[0])
  const open = num(row[1])
  const high = num(row[2])
  const low = num(row[3])
  const close = num(row[4])
  const volume = num(row[5])
  const closeTime = num(row[6])
  if (
    openTime === undefined ||
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined ||
    volume === undefined ||
    closeTime === undefined
  ) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance klines: malformed row values for ${symbol}`)
  }
  return { openTime, open, high, low, close, volume, closeTime }
}

export class BinanceRestClient {
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch

  constructor(options: BinanceRestOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // 缺省经 globalThis 取 fetch：调用时解析，便于 vi.stubGlobal 等全局替换也生效。
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async #request(path: string, params: Record<string, string>): Promise<unknown> {
    const query = new URLSearchParams(params).toString()
    const target = query ? `${this.#baseUrl}${path}?${query}` : `${this.#baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException(`request timed out after ${this.#timeoutMs}ms`, 'TimeoutError')),
      this.#timeoutMs,
    )
    let res: Response
    try {
      res = await this.#fetchImpl(target, { signal: controller.signal })
    } catch (cause) {
      const timedOut = controller.signal.aborted
      throw new TradingServiceError(
        'TRADING_NETWORK',
        timedOut ? `Binance ${path}: request timed out after ${this.#timeoutMs}ms` : `Binance ${path}: network error`,
        cause,
      )
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw await httpToTradingError(res, path)
    try {
      return await res.json()
    } catch (cause) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance ${path}: invalid JSON response`, cause)
    }
  }

  /**
   * 最新行情：/api/v3/ticker/24hr 提供最新价与 24h 量，/api/v3/ticker/bookTicker 补充 bid/ask。
   */
  async getTicker(symbol: string): Promise<Ticker> {
    const sym = requireSymbol(symbol)
    const [day, book] = await Promise.all([
      this.#request('/api/v3/ticker/24hr', { symbol: sym }),
      this.#request('/api/v3/ticker/bookTicker', { symbol: sym }),
    ])
    const d = day as Record<string, unknown>
    const b = book as Record<string, unknown>
    const price = num(d.lastPrice)
    if (price === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance ticker for ${sym}: missing/invalid lastPrice`)
    }
    const bid = num(b.bidPrice)
    const ask = num(b.askPrice)
    const volume = num(d.volume)
    const resolvedSymbol = typeof d.symbol === 'string' && d.symbol ? d.symbol : sym
    return {
      symbol: resolvedSymbol,
      price,
      timestamp: Date.now(),
      ...(bid !== undefined ? { bid } : {}),
      ...(ask !== undefined ? { ask } : {}),
      ...(volume !== undefined ? { volume } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval, limit = 100): Promise<Kline[]> {
    const sym = requireSymbol(symbol)
    if (!isInterval(interval)) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_INTERVAL', `Binance klines: unsupported interval ${String(interval)}`)
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance klines: limit must be an integer within 1..1000, got ${limit}`)
    }
    const body = await this.#request('/api/v3/klines', { symbol: sym, interval, limit: String(limit) })
    if (!Array.isArray(body)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance klines for ${sym}: unexpected response shape`)
    }
    return body.map((row) => parseKlineRow(row, sym))
  }

  /**
   * 全部可交易现货标的名册（GET /api/v3/exchangeInfo，status=TRADING 过滤，Issue #15）。
   * 输出 symbol 为规范形（BTCUSDT），name 为 baseAsset/quoteAsset（如 BTC/USDT）。
   */
  async listInstruments(): Promise<Array<{ symbol: string; name?: string }>> {
    const body = await this.#request('/api/v3/exchangeInfo', {})
    const info = body as { symbols?: Array<{ symbol?: string; status?: string; baseAsset?: string; quoteAsset?: string }> }
    if (!Array.isArray(info?.symbols)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Binance exchangeInfo: invalid response shape')
    }
    const result: Array<{ symbol: string; name?: string }> = []
    for (const item of info.symbols) {
      if (item && item.status === 'TRADING' && typeof item.symbol === 'string' && item.symbol) {
        const name = item.baseAsset && item.quoteAsset ? `${item.baseAsset}/${item.quoteAsset}` : undefined
        result.push({ symbol: item.symbol, ...(name ? { name } : {}) })
      }
    }
    return result
  }
}
