/**
 * Stooq 公共 CSV 客户端（dsh-trading us 切片）。
 *
 * 独立于插件 glue：仅依赖 @dsh-trading/api 的类型词汇，无 cordis/dsh-tools 运行时依赖，
 * 便于单测与脚本直接消费（fetch 可注入）。
 *
 * 数据面（2026-08-31 实测，证据 spikes/impl-us/REPORT.md）：
 *   - 历史K线 CSV：https://stooq.com/q/d/l/?s=<symbol>&i=<interval>（i ∈ d/w/m/q/y 与
 *     分钟级 1/5/15/30/60）。响应为 CSV（Date,Open,High,Low,Close,Volume）。
 *   - 手册原文引用的报价端点 /q/l/?s=…&f=sd2t2ohlcv&h&e=csv 已 404（stooq.com 与
 *     stooq.pl 均实测 404，参数变体亦然）→ getTicker 以最新日 K 收盘价近似，注释明确标注。
 *   - stooq 对无浏览器特征的客户端先下发 JS proof-of-work 挑战页（/__verify），本客户端
 *     不做任何挑战求解/伪装（那是敌意自动化）——检测到挑战页抛 TRADING_RATE_LIMITED，
 *     提示用户在浏览器正常访问一次后重试或更换出口；检测到 Access denied（匿名下载被拒，
 *     疑似出口 IP 段/账户策略）抛 TRADING_AUTH_FAILED。
 *
 * 合规（README 铁律 #5）：免费公开端点、无 key；个人/非商业使用边界以 stooq.com 条款
 * 为准（https://stooq.com/q/dl/ 页脚与 Terms）；本仓不缓存/不再分发行情数据。
 *
 * @module @dsh-trading/connector-stooq/rest
 */

import type { Interval, Kline, MarketDataService, Ticker, TradingErrorCode } from '@dsh-trading/api'

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
/* 符号规范化：AAPL / aapl → aapl.us（Stooq 美股小写 + .us 后缀）            */
/* ------------------------------------------------------------------ */

/** Stooq 符号：小写字母/数字，可选 `.xx` 国家/交易所后缀（美股固定 `.us`；jp/uk/de/hk… 亦存在）。 */
const STOOQ_SYMBOL_PATTERN = /^[a-z0-9]{1,10}(?:\.[a-z]{1,3})?$/

/** 规范化并校验符号：接受 `AAPL` / `aapl.us`，统一为小写；无后缀补 `.us`。 */
export function normalizeStooqSymbol(symbol: string): string {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      'Symbol must be a non-empty string, e.g. AAPL or aapl.us',
    )
  }
  const lower = symbol.trim().toLowerCase()
  const normalized = lower.includes('.') ? lower : `${lower}.us`
  if (!STOOQ_SYMBOL_PATTERN.test(normalized)) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Symbol ${JSON.stringify(symbol)} is not a valid Stooq symbol (expected like AAPL / aapl.us)`,
    )
  }
  return normalized
}

/* ------------------------------------------------------------------ */
/* interval → Stooq i= 参数映射                                             */
/* ------------------------------------------------------------------ */

/** api Interval 词汇的受支持子集 → Stooq `i=` 值（分钟级数字；d/w/m 日/周/月）。 */
const INTERVAL_TO_STOOQ: ReadonlyMap<Interval, string> = new Map([
  ['1m', '1'],
  ['5m', '5'],
  ['15m', '15'],
  ['30m', '30'],
  ['1h', '60'],
  ['1d', 'd'],
  ['1w', 'w'],
  ['1M', 'm'],
])

/** 工具 parameters enum 用：受支持 interval 词汇（api Interval 的 Stooq 子集）。 */
export const INTERVAL_VOCABULARY: readonly string[] = [...INTERVAL_TO_STOOQ.keys()]

export function isSupportedInterval(value: Interval): boolean {
  return INTERVAL_TO_STOOQ.has(value)
}

/* ------------------------------------------------------------------ */
/* 时间处理                                                                */
/* ------------------------------------------------------------------ */

/** 日线行 `YYYY-MM-DD` → epoch ms（UTC 当日零点，行情日界语义，非交易时段语义）。 */
function dailyDateToEpochMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error(`invalid stooq daily date ${JSON.stringify(date)}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * 日线收盘时刻 = 当日 UTC 零点 + 1 天 − 1ms（K 线 closeTime 语义，与 Binance 映射同构）。
 */
const DAY_MS = 86_400_000

/** 美东墙钟时间 `YYYY-MM-DD HH:MM` → epoch ms（Stooq 分钟级时间戳为交易所当地时区）。 */
export function easternWallTimeToEpochMs(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!m) throw new Error(`invalid stooq intraday timestamp ${JSON.stringify(value)}`)
  const [, y, mo, d, h, mi, s] = m
  // 用 Intl 求 America/New_York 在该墙钟时刻的 UTC 偏移（含夏令时）：
  // 先按 UTC 猜一个 epoch，再按猜值处的时区偏移修正一轮（分钟级精度足够）。
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))
  const offsetMs = (date: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(date))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
    // hour 可能出现 "24"（某些 ICU 的午夜表示），归一到 0。
    const hour = get('hour') % 24
    return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - date
  }
  return guess - offsetMs(guess)
}

/* ------------------------------------------------------------------ */
/* CSV 解析（最小实现：支持引号转义；Stooq 数值场均为裸数字）                  */
/* ------------------------------------------------------------------ */

/** 解析单行 CSV（RFC4180 子集：双引号包裹 + `""` 转义）。 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++ } else { inQuotes = false }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

/** 宽松转 number（非有限值返回 undefined）。 */
function num(value: string): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/* ------------------------------------------------------------------ */
/* Stooq CSV 客户端（无凭证、可注入 fetch，便于单测）                          */
/* ------------------------------------------------------------------ */

const DEFAULT_BASE_URL = 'https://stooq.com'
const DEFAULT_TIMEOUT_MS = 10_000

export interface StooqRestOptions {
  /** 覆盖站点 base（测试/反代用；stooq.pl 镜像同路径），末尾不带斜杠。 */
  readonly baseUrl?: string
  /** 单请求超时（ms），默认 10s。 */
  readonly timeoutMs?: number
  /** 注入 fetch 实现；缺省用全局 fetch（Node 22+ 内置）。 */
  readonly fetchImpl?: typeof fetch
}

export class StooqRestClient {
  // 纯数据客户端（非 cordis Service 类），可用 # 私有字段（realm 代理风险只涉 Service 基类，
  // 见 connector-binance/rest.ts 同款分工）。
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch

  constructor(options: StooqRestOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async #requestCsv(path: string, params: Record<string, string>): Promise<string> {
    const query = new URLSearchParams(params).toString()
    const target = `${this.#baseUrl}${path}?${query}`
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException(`request timed out after ${this.#timeoutMs}ms`, 'TimeoutError')),
      this.#timeoutMs,
    )
    let res: Response
    try {
      res = await this.#fetchImpl(target, { signal: controller.signal, headers: { accept: 'text/csv,text/html,*/*' } })
    } catch (cause) {
      const timedOut = controller.signal.aborted
      throw new TradingServiceError(
        'TRADING_NETWORK',
        timedOut ? `Stooq ${path}: request timed out after ${this.#timeoutMs}ms` : `Stooq ${path}: network error`,
        cause,
      )
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text().catch(() => '')
    if (text.includes('__verify') || text.includes('requires JavaScript to verify')) {
      // 站点反爬挑战页（JS proof-of-work）：本客户端不解挑战——诚实上报，让调用方换浏览器
      // 会话/出口重试。映射 TRADING_RATE_LIMITED（最接近「访问被暂时性限流」语义）。
      throw new TradingServiceError(
        'TRADING_RATE_LIMITED',
        `Stooq ${path}: the endpoint served an anti-bot JavaScript challenge instead of CSV data. `
        + 'Open stooq.com once in a normal browser (or use a different egress) so the session clears its check, then retry.',
      )
    }
    const trimmed = text.trim()
    if (trimmed === 'Access denied' || trimmed === 'Odmowa dostępu' || trimmed === 'Przekroczony dzienny limit wywołań') {
      // 匿名 CSV 下载被拒（2026-08-31 实测：本出口清挑战后仍 denied；亦见日内调用上限文案）。
      throw new TradingServiceError(
        'TRADING_AUTH_FAILED',
        `Stooq ${path}: upstream denied anonymous data access ("${trimmed}"). Stooq restricts CSV downloads by `
        + 'egress/account policy — personal non-commercial use boundary is governed by stooq.com terms.',
      )
    }
    if (!res.ok) {
      throw new TradingServiceError(
        res.status === 429 ? 'TRADING_RATE_LIMITED' : 'TRADING_EXCHANGE_ERROR',
        `Stooq ${path}: HTTP ${res.status} ${res.statusText}`,
      )
    }
    if (!trimmed) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Stooq ${path}: empty response`)
    }
    return text
  }

  /** 拉取并解析 K 线 CSV（全量历史/可用窗口），行序为旧→新。 */
  async getHistorical(symbol: string, interval: Interval): Promise<Kline[]> {
    const sym = normalizeStooqSymbol(symbol)
    const i = INTERVAL_TO_STOOQ.get(interval)
    if (i === undefined) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_INTERVAL',
        `Stooq klines: unsupported interval ${String(interval)} — supported: ${INTERVAL_VOCABULARY.join('/')}`,
      )
    }
    const text = await this.#requestCsv('/q/d/l/', { s: sym, i })
    const lines = text.trim().split(/\r?\n/)
    if (lines[0] !== 'Date,Open,High,Low,Close,Volume') {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Stooq klines for ${sym}: unexpected payload (expected "Date,Open,High,Low,Close,Volume" header)`,
      )
    }
    const intraday = i !== 'd' && i !== 'w' && i !== 'm'
    const klines: Kline[] = []
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue
      const f = splitCsvLine(line)
      if (f.length < 6) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Stooq klines for ${sym}: malformed row ${JSON.stringify(line)}`)
      }
      const [dateField, o, h, l, c, v] = f as [string, string, string, string, string, string]
      const open = num(o)
      const high = num(h)
      const low = num(l)
      const close = num(c)
      const volume = num(v)
      if (open === undefined || high === undefined || low === undefined || close === undefined) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Stooq klines for ${sym}: malformed row values ${JSON.stringify(line)}`)
      }
      // 未上市期 Stooq 会给 "N"（非数值）Volume：契约要 number，置 0 并如实保留价格缺失校验。
      const openTime = intraday ? easternWallTimeToEpochMs(dateField) : dailyDateToEpochMs(dateField)
      klines.push({
        openTime,
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
        closeTime: intraday
          ? openTime + 60_000 * Number(i) - 1
          : openTime + DAY_MS - 1,
      })
    }
    if (klines.length === 0) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Stooq klines for ${sym}: no data rows (unknown/delisted symbol?)`)
    }
    return klines
  }

  /**
   * 最新行情快照。原报价端点 /q/l/ 已 404（手册引用失真，2026-08-31 实测）——
   * 以最新日 K 收盘价近似：price=close、volume=当日量；timestamp=该日收盘时刻。
   * 盘前盘后不反映，工具描述必须向模型说明该局限。
   */
  async getTicker(symbol: string): Promise<Ticker> {
    const sym = normalizeStooqSymbol(symbol)
    const klines = await this.getHistorical(sym, '1d')
    const last = klines[klines.length - 1]
    if (!last) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Stooq ticker for ${sym}: no data rows`)
    }
    return {
      symbol: sym.toUpperCase(),
      price: last.close,
      volume: last.volume,
      timestamp: last.closeTime,
    }
  }
}
