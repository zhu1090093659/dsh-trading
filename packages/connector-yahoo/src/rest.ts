/**
 * Yahoo Finance v8 chart API 客户端（dsh-trading us 切片，任务 G 数据面切换）。
 *
 * 独立于插件 glue：仅依赖 @dsh-trading/api 的类型词汇，无 cordis/dsh-tools 运行时依赖，
 * 便于单测与脚本直接消费（fetch 可注入）。
 *
 * 数据面（2026-08-29 本出口实测，证据 spikes/impl-us-yahoo/）：
 *   - GET {base}/v8/finance/chart/<symbol>?interval=<i>&range=<r> → JSON
 *     chart.result[0].{meta, timestamp[], indicators.quote[0].{open,high,low,close,volume}[]}。
 *   - interval 支持 1m/5m/15m/30m/60m/1d/1wk/1mo；需 User-Agent 头（Mozilla/5.0 即可）。
 *   - 非官方 API：无 key、无 SLA；实测 meta.regularMarketPrice 与同响应 60m 序列最后收盘
 *     一致（float32 精度）；日线序列的「最新已收盘交易日」可能滞后补齐（周五收盘后周六
 *     早晨仍缺周五日线，证据 probe-output.txt）——getTicker 的价格/时间取 meta（权威实时
 *     面），volume 取最新日 K 量并在工具描述明示该滞后。
 *
 * 合规（README 铁律 #5）：Yahoo Finance 非官方 API，个人使用属灰色但被普遍使用的边界，
 * 以 Yahoo 服务条款为准（https://legal.yahoo.com/terms-of-use/）；无凭证、本仓不缓存
 * 不再分发行情数据。
 *
 * @module @dsh-trading/connector-yahoo/rest
 */

import type { Interval, Kline, Ticker, TradingErrorCode } from '@dsh-trading/api'

/* ------------------------------------------------------------------ */
/* 错误载体（api 包词汇的运行时映射，与 connector-stooq 同构）                */
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
/* 符号规范化：aapl → AAPL（Yahoo 美股大写；BRK-B / 7203.T / ^GSPC 亦合法）   */
/* ------------------------------------------------------------------ */

/** Yahoo 符号：字母/数字或指数前导 `^` 开头，可含 `.` `-` `^`（ADR/优先股/指数写法）。 */
const YAHOO_SYMBOL_PATTERN = /^[A-Z0-9^][A-Z0-9.\-^]{0,15}$/

/** 规范化并校验符号：接受 `AAPL` / `aapl` / `brk-b`，统一为大写；不补任何后缀。 */
export function normalizeYahooSymbol(symbol: string): string {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      'Symbol must be a non-empty string, e.g. AAPL or BRK-B',
    )
  }
  const normalized = symbol.trim().toUpperCase()
  if (!YAHOO_SYMBOL_PATTERN.test(normalized)) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Symbol ${JSON.stringify(symbol)} is not a valid Yahoo Finance symbol (expected like AAPL / BRK-B / 7203.T)`,
    )
  }
  return normalized
}

/* ------------------------------------------------------------------ */
/* interval → Yahoo interval= / range= 映射                                  */
/* ------------------------------------------------------------------ */

/** api Interval 词汇的受支持子集 → Yahoo `interval=` 值。 */
const INTERVAL_TO_YAHOO: ReadonlyMap<Interval, string> = new Map([
  ['1m', '1m'],
  ['5m', '5m'],
  ['15m', '15m'],
  ['30m', '30m'],
  ['1h', '60m'],
  ['1d', '1d'],
  ['1w', '1wk'],
  ['1M', '1mo'],
])

/** 工具 parameters enum 用：受支持 interval 词汇（与 connector-stooq 同一子集口径）。 */
export const INTERVAL_VOCABULARY: readonly string[] = [...INTERVAL_TO_YAHOO.keys()]

export function isSupportedInterval(value: Interval): boolean {
  return INTERVAL_TO_YAHOO.has(value)
}

/** 每个 interval 的默认取数窗口（1m 上限 7 天；日线以上给足年化历史）。 */
const RANGE_BY_INTERVAL: ReadonlyMap<Interval, string> = new Map([
  ['1m', '7d'],
  ['5m', '1mo'],
  ['15m', '1mo'],
  ['30m', '1mo'],
  ['1h', '3mo'],
  ['1d', '1y'],
  ['1w', '5y'],
  ['1M', '10y'],
])

/** 单根 K 线名义时长（ms），closeTime = openTime + 时长 − 1。1M 按 30 天近似（月界不精确，工具语义足够）。 */
const INTERVAL_MS: ReadonlyMap<Interval, number> = new Map([
  ['1m', 60_000],
  ['5m', 300_000],
  ['15m', 900_000],
  ['30m', 1_800_000],
  ['1h', 3_600_000],
  ['1d', 86_400_000],
  ['1w', 7 * 86_400_000],
  ['1M', 30 * 86_400_000],
])

/* ------------------------------------------------------------------ */
/* chart 响应解析                                                            */
/* ------------------------------------------------------------------ */

/** v8 chart 响应的最小类型面（只取本客户端消费的字段）。 */
export interface YahooChartResult {
  meta: {
    currency?: string
    regularMarketPrice?: number
    regularMarketTime?: number
    regularMarketDayHigh?: number
    regularMarketDayLow?: number
    exchangeTimezoneName?: string
  }
  timestamp: number[]
  indicators: {
    quote: Array<{
      open?: Array<number | null>
      high?: Array<number | null>
      low?: Array<number | null>
      close?: Array<number | null>
      volume?: Array<number | null>
    }>
  }
}

export interface YahooChartEnvelope {
  chart: {
    error?: { code?: string; description?: string } | null
    result?: YahooChartResult[] | null
  }
}

/** 把 timestamp[] + quote 序列对齐成 Kline[]（旧→新；null 行如实丢弃）。 */
export function parseChartBars(result: YahooChartResult, interval: Interval): Kline[] {
  const quote = result.indicators.quote[0] ?? {}
  const periodMs = INTERVAL_MS.get(interval) ?? 86_400_000
  const bars: Kline[] = []
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = quote.close?.[i]
    if (close == null) continue
    const openTime = result.timestamp[i]! * 1000
    bars.push({
      openTime,
      open: quote.open?.[i] ?? close,
      high: quote.high?.[i] ?? close,
      low: quote.low?.[i] ?? close,
      close,
      volume: quote.volume?.[i] ?? 0,
      closeTime: openTime + periodMs - 1,
    })
  }
  return bars
}

/* ------------------------------------------------------------------ */
/* Yahoo chart 客户端（无凭证、可注入 fetch，便于单测）                        */
/* ------------------------------------------------------------------ */

const DEFAULT_BASE_URL = 'https://query1.finance.yahoo.com'
const DEFAULT_TIMEOUT_MS = 10_000
/** 非官方 API 但需浏览器特征头；Mozilla/5.0 裸 UA 实测即可（2026-08-29 本出口）。 */
const DEFAULT_USER_AGENT = 'Mozilla/5.0'

export interface YahooRestOptions {
  /** 覆盖 API base（测试/反代用），末尾不带斜杠。query2 是同一服务的备用主机。 */
  readonly baseUrl?: string
  /** 单请求超时（ms），默认 10s。 */
  readonly timeoutMs?: number
  /** 注入 fetch 实现；缺省用全局 fetch（Node 22+ 内置）。 */
  readonly fetchImpl?: typeof fetch
  /** 覆盖 User-Agent（默认 Mozilla/5.0 裸 UA，实测够用）。 */
  readonly userAgent?: string
}

export class YahooRestClient {
  // 纯数据客户端（非 cordis Service 类），可用 # 私有字段（与 connector-stooq/rest.ts 同款分工）。
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch
  readonly #userAgent: string

  constructor(options: YahooRestOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  }

  async #requestChart(symbol: string, interval: Interval, rangeOverride?: string): Promise<YahooChartResult> {
    const sym = normalizeYahooSymbol(symbol)
    const yInterval = INTERVAL_TO_YAHOO.get(interval)
    if (yInterval === undefined) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_INTERVAL',
        `Yahoo klines: unsupported interval ${String(interval)} — supported: ${INTERVAL_VOCABULARY.join('/')}`,
      )
    }
    const range = rangeOverride ?? RANGE_BY_INTERVAL.get(interval) ?? '1y'
    const query = new URLSearchParams({ interval: yInterval, range })
    const target = `${this.#baseUrl}/v8/finance/chart/${encodeURIComponent(sym)}?${query}`
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException(`request timed out after ${this.#timeoutMs}ms`, 'TimeoutError')),
      this.#timeoutMs,
    )
    let res: Response
    try {
      res = await this.#fetchImpl(target, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': this.#userAgent },
      })
    } catch (cause) {
      const timedOut = controller.signal.aborted
      throw new TradingServiceError(
        'TRADING_NETWORK',
        timedOut ? `Yahoo chart ${sym}: request timed out after ${this.#timeoutMs}ms` : `Yahoo chart ${sym}: network error`,
        cause,
      )
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      throw new TradingServiceError(
        res.status === 429 ? 'TRADING_RATE_LIMITED' : 'TRADING_EXCHANGE_ERROR',
        `Yahoo chart ${sym}: HTTP ${res.status} ${res.statusText}`,
      )
    }
    let envelope: YahooChartEnvelope
    try {
      envelope = (await res.json()) as YahooChartEnvelope
    } catch (cause) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Yahoo chart ${sym}: response is not valid JSON`, cause)
    }
    if (envelope.chart.error) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Yahoo chart ${sym}: upstream error ${envelope.chart.error.code ?? ''} ${envelope.chart.error.description ?? ''}`.trim(),
      )
    }
    const result = envelope.chart.result?.[0]
    if (!result || !Array.isArray(result.timestamp) || result.timestamp.length === 0) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Yahoo chart ${sym}: no data rows (unknown/delisted symbol?)`,
      )
    }
    return result
  }

  /** 拉取并解析 K 线（旧→新全窗口，由服务层按 limit 截尾）。 */
  async getKlines(symbol: string, interval: Interval): Promise<Kline[]> {
    const sym = normalizeYahooSymbol(symbol)
    const result = await this.#requestChart(sym, interval)
    const bars = parseChartBars(result, interval)
    if (bars.length === 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Yahoo klines for ${sym}: no non-null bars in range`)
    }
    return bars
  }

  /**
   * 最新行情快照：单请求 interval=1d&range=5d。
   * price/timestamp 取 meta.regularMarketPrice/regularMarketTime（权威实时面，含最近收盘）；
   * volume 取该响应最新日 K 量——Yahoo 日线汇总可能滞后补齐最新交易日（2026-08-29 实证），
   * 工具描述必须向模型明示该局限。
   */
  async getTicker(symbol: string): Promise<Ticker> {
    const sym = normalizeYahooSymbol(symbol)
    // 5d 足够覆盖最近交易日且窗口最小（证据：spikes/impl-us-yahoo/EVIDENCE.md）。
    const result = await this.#requestChart(sym, '1d', '5d')
    const bars = parseChartBars(result, '1d')
    const last = bars[bars.length - 1]
    const price = result.meta.regularMarketPrice ?? last?.close
    if (price === undefined || !last) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Yahoo ticker for ${sym}: no price in meta and no bars`)
    }
    return {
      symbol: sym,
      price,
      volume: last.volume,
      timestamp: result.meta.regularMarketTime != null ? result.meta.regularMarketTime * 1000 : last.closeTime,
    }
  }
}
