/**
 * 腾讯公共行情客户端（dsh-trading cn+hk 双市场切片）——单包双市场的数据面。
 *
 * 独立于插件 glue：仅依赖 @dsh-trading/api 的类型词汇，无 cordis/dsh-tools 运行时依赖，
 * 便于单测与脚本直接消费（fetch 可注入）。
 *
 * 数据面（2026-08-31 本出口实测，原始证据 spikes/impl-cn-hk/r1-*.raw / r2-*.json）：
 *   - 实时报价：GET https://qt.gtimg.cn/q=<wire>。响应 **GBK 编码**（content-type:
 *     text/html; charset=GBK）——必须 TextDecoder('gbk') 解码，UTF-8 解出中文乱码。
 *     body 形如 `v_sh600519="1~贵州茅台~600519~1297.40~..."`，`~` 分隔。
 *     cn（sh600519/sz000001）与 hk（r_hk00700）**字段布局不同**（详见 parseCnTicker /
 *     parseHkTicker 注释）。
 *   - 日/周/月 K：GET https://web.ifzq.gtimg.cn/appstock/app/{fqkline,hkfqkline}/get
 *     ?param=<code>,<tf>,,,<count>,qfq → JSON data.<code>.qfq<day|week|month>。
 *     行字段序是 **开收高低量**（open,close,high,low,volume）——与 OHLC 直觉相反，
 *     解析错序 K 线整体失真。hk 行第 7 个元素起是分红/回购等附加对象，须丢弃。
 *     cn 用 fqkline + sh/sz 前缀；**hk 报价用 r_hk 前缀而 K 线用 hk 前缀**——
 *     r_hk00700 打 K 线端点返回 {"code":0,"msg":"param error"}（实测）。
 *   - 分钟线端点（kline/mkline）在本出口 fetch 失败，未实现（待验证）。
 *
 * 合规（README 铁律 #5）：腾讯公共行情端点、无 key、无官方授权；个人使用边界自负，
 * 本仓不缓存、不再分发行情数据（详见 README 数据源节）。
 *
 * @module @dsh-trading/connector-tencent/rest
 */

import type { Interval, Kline, Ticker, TradingErrorCode } from '@dsh-trading/api'

/* ------------------------------------------------------------------ */
/* 错误载体（api 包词汇的运行时映射，与 connector-stooq 同构）               */
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
/* 符号规范化（单包双市场的市场分流在此收敛）                                  */
/* ------------------------------------------------------------------ */

export type TencentMarket = 'cn' | 'hk'

// 规范词汇（docs/symbol-vocabulary.md）：接受 600519.SH / 600519.sh / SH600519 / 裸 6 位。
const CN_SYMBOL_PATTERN = /^(?:(sh|sz)(\d{6})|(\d{6})(?:\.(sh|sz))?)$/
// 规范词汇：接受 00700.HK（规范形）与裸 1-5 位数字（宽容输入）。
const HK_SYMBOL_PATTERN = /^(\d{1,5})(?:\.hk)?$/

/**
 * 规范化 A 股符号：接受 `600519` / `SH600519` / `sh600519` / `sz000001`，统一为
 * 腾讯 wire 形态小写 `<sh|sz><6位数字>`。6/9 开头→sh（沪，含科创板 688），0/3 开头→sz
 * （深，含创业板 300）。4/8 开头（北交所）不在本切片支持范围。
 */
export function normalizeCnSymbol(symbol: string): string {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      'Symbol must be a non-empty string, e.g. 600519 / SH600519 / sz000001',
    )
  }
  const raw = symbol.trim().toLowerCase()
  const m = CN_SYMBOL_PATTERN.exec(raw)
  if (!m) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Symbol ${JSON.stringify(symbol)} is not a valid CN A-share symbol (expected 6-digit code, optionally SH/SZ prefixed)`,
    )
  }
  if (m[1]) return `${m[1]}${m[2]}` // 前缀形 sh600519
  const code = m[3]
  if (m[4]) return `${m[4]}${code}` // 规范形 600519.SH（后缀即交易所）
  const prefix = code.startsWith('6') || code.startsWith('9') ? 'sh' : 'sz' // 裸码宽容输入：按首位推断
  return `${prefix}${code}`
}

/**
 * 规范化港股符号：接受 `00700` / `700`（1-5 位数字，不足 5 位左补零），统一为 5 位
 * 数字形态 `00700`。wire 形态由客户端按端点再加前缀（报价 `r_hk` / K线 `hk`）。
 */
export function normalizeHkSymbol(symbol: string): string {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      'Symbol must be a non-empty string, e.g. 00700 or 700',
    )
  }
  const m = HK_SYMBOL_PATTERN.exec(symbol.trim().toLowerCase())
  if (!m) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Symbol ${JSON.stringify(symbol)} is not a valid HK stock code (expected 1-5 digits, e.g. 700 / 00700)`,
    )
  }
  return m[1].padStart(5, '0')
}

/** 按市场规范化符号并返回市场。 */
export function normalizeSymbol(market: TencentMarket, symbol: string): string {
  return market === 'hk' ? normalizeHkSymbol(symbol) : normalizeCnSymbol(symbol)
}

/**
 * 输出归一 → 规范形（docs/symbol-vocabulary.md）：cn wire 形 sh600519 → 600519.SH；
 * hk 5 位形 00700 → 00700.HK。下游永远看到市场规范词汇。
 */
export function toCanonicalTencentSymbol(market: TencentMarket, wireOrCode: string): string {
  if (market === 'hk') return `${wireOrCode.replace(/^hk/i, '')}.HK`
  const m = /^(sh|sz)(\d{6})$/i.exec(wireOrCode)
  return m ? `${m[2]}.${(m[1] ?? '').toUpperCase()}` : wireOrCode
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* interval → 腾讯周期参数（日周月 fqkline / 分钟 mkline）              */
/* ------------------------------------------------------------------ */

export type TencentKlineType = 'fqkline' | 'mkline'

export interface TencentIntervalDef {
  readonly type: TencentKlineType
  readonly tf: string
  readonly key: string
  readonly durationMs: number
}

/** api Interval 词汇的受支持子集 → 腾讯 tf= 值与响应键。 */
const INTERVAL_TO_TENCENT: ReadonlyMap<Interval, TencentIntervalDef> = new Map([
  ['5m', { type: 'mkline', tf: 'm5', key: 'm5', durationMs: 5 * 60_000 }],
  ['30m', { type: 'mkline', tf: 'm30', key: 'm30', durationMs: 30 * 60_000 }],
  ['1d', { type: 'fqkline', tf: 'day', key: 'qfqday', durationMs: 86_400_000 }],
  ['1w', { type: 'fqkline', tf: 'week', key: 'qfqweek', durationMs: 7 * 86_400_000 }],
  ['1M', { type: 'fqkline', tf: 'month', key: 'qfqmonth', durationMs: 30 * 86_400_000 }],
])

/** 工具 parameters enum 用：受支持 interval 词汇。 */
export const INTERVAL_VOCABULARY: readonly string[] = [...INTERVAL_TO_TENCENT.keys()]

/* ------------------------------------------------------------------ */
/* 时间处理                                                                */
/* ------------------------------------------------------------------ */

/**
 * 分钟 K 线时间 `YYYYMMDDHHmm` → epoch ms（Asia/Shanghai 墙钟，12 位紧凑格式）。
 */
export function minuteKlineTimeToEpochMs(value: string, timeZone = 'Asia/Shanghai'): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid tencent minute kline timestamp ${JSON.stringify(value)}`)
  const [, y, mo, d, h, mi] = m
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0)
  const offsetMs = (date: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(date))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const hour = get('hour') % 24
    return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - date
  }
  return guess - offsetMs(guess)
}

/** K 线日期 `YYYY-MM-DD` → epoch ms（UTC 当日零点锚定，行情日界语义，与 stooq 映射同构）。 */
export function klineDateToEpochMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid tencent kline date ${JSON.stringify(date)}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * 交易所当地墙钟 → epoch ms（Intl 求时区偏移，含夏令时；同 stooq easternWallTimeToEpochMs
 * 的两轮逼近法，泛化时区参数）。cn 报价时间是 `YYYYMMDDHHMMSS`（Asia/Shanghai），
 * hk 报价时间是 `YYYY/MM/DD HH:MM:SS`（Asia/Hong_Kong）。
 */
export function wallTimeToEpochMs(value: string, timeZone: string): number {
  // cn 报价时间是紧凑形态 YYYYMMDDHHMMSS；hk 是 YYYY/MM/DD HH:MM:SS——先归一化。
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value)
  const normalized = (compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}`
    : value.replace(/\//g, '-')
  ).replace(/^(\d{4}-\d{2}-\d{2})$/, '$1T00:00:00')
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalized)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid tencent quote timestamp ${JSON.stringify(value)}`)
  const [, y, mo, d, h, mi, s] = m
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))
  const offsetMs = (date: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(date))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const hour = get('hour') % 24
    return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - date
  }
  return guess - offsetMs(guess)
}

/* ------------------------------------------------------------------ */
/* 行解析                                                                  */
/* ------------------------------------------------------------------ */

/** 宽松转 number（非有限值返回 undefined）。 */
function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** cn 报价扩展字段（Ticker 契约的超集；风控 skill 用涨停/跌停价）。 */
export interface CnTickerExtra {
  readonly market: 'cn'
  readonly name: string
  readonly prevClose?: number
  readonly open?: number
  readonly high?: number
  readonly low?: number
  /** 涨停价（f47）。 */
  readonly limitUp?: number
  /** 跌停价（f48）。 */
  readonly limitDown?: number
  readonly change?: number
  readonly changePercent?: number
  readonly currency: 'CNY'
}

/** hk 报价扩展字段。 */
export interface HkTickerExtra {
  readonly market: 'hk'
  readonly name: string
  readonly prevClose?: number
  readonly open?: number
  readonly high?: number
  readonly low?: number
  readonly change?: number
  readonly changePercent?: number
  /** 52 周最高（f48）。 */
  readonly week52High?: number
  /** 52 周最低（f49）。 */
  readonly week52Low?: number
  readonly currency: 'HKD'
}

export type TencentTicker = Ticker & (CnTickerExtra | HkTickerExtra)

/**
 * cn 报价字段布局（v_sh600519，2026-08-31 实测 sh600519，88 字段）：
 * 1=名称 2=代码 3=现价 4=昨收 5=今开 6=成交量(**手**) 9=买一价 19=卖一价
 * 30=时间 YYYYMMDDHHMMSS(Asia/Shanghai) 31=涨跌 32=涨跌% 33=最高 34=最低
 * 35="价/量(手)/额(元)" 47=涨停价 48=跌停价 82=币种(CNY)。
 */
function parseCnTicker(fields: string[], timestamp: number): TencentTicker {
  const price = num(fields[3])
  if (price === undefined) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Tencent CN ticker: missing/invalid price field')
  }
  const bid = num(fields[9])
  const ask = num(fields[19])
  const volumeLots = num(fields[6])
  return {
    market: 'cn',
    currency: 'CNY',
    name: fields[1] ?? '',
    symbol: String(fields[2] ?? ''),
    price,
    ...(bid !== undefined && bid > 0 ? { bid } : {}),
    ...(ask !== undefined && ask > 0 ? { ask } : {}),
    // cn 成交量单位是手（100 股）：统一归一到股，与 hk 对齐。
    ...(volumeLots !== undefined ? { volume: volumeLots * 100 } : {}),
    timestamp,
    prevClose: num(fields[4]),
    open: num(fields[5]),
    high: num(fields[33]),
    low: num(fields[34]),
    limitUp: num(fields[47]),
    limitDown: num(fields[48]),
    change: num(fields[31]),
    changePercent: num(fields[32]),
  }
}

/**
 * hk 报价字段布局（v_r_hk00700，2026-08-31 实测腾讯控股，78 字段——与 cn 布局不同）：
 * 1=名称 2=代码 3=现价 4=昨收 5=今开 6=成交量(**股**，非手) 30=时间 YYYY/MM/DD
 * HH:MM:SS(Asia/Hong_Kong) 31=涨跌 32=涨跌% 33=最高 34=最低 37=成交额(HKD)
 * 46=英文名 48=52周高 49=52周低 75=币种(HKD)。买卖档位字段全 0（r_hk 实时档不可用），
 * bid/ask 置缺省。
 */
function parseHkTicker(fields: string[], timestamp: number): TencentTicker {
  const price = num(fields[3])
  if (price === undefined) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Tencent HK ticker: missing/invalid price field')
  }
  return {
    market: 'hk',
    currency: 'HKD',
    name: fields[1] ?? '',
    symbol: String(fields[2] ?? ''),
    price,
    ...(num(fields[6]) !== undefined ? { volume: num(fields[6]) } : {}),
    timestamp,
    prevClose: num(fields[4]),
    open: num(fields[5]),
    high: num(fields[33]),
    low: num(fields[34]),
    change: num(fields[31]),
    changePercent: num(fields[32]),
    week52High: num(fields[48]),
    week52Low: num(fields[49]),
  }
}

/* ------------------------------------------------------------------ */
/* 腾讯行情客户端（无凭证、可注入 fetch，便于单测）                            */
/* ------------------------------------------------------------------ */

const DEFAULT_QUOTE_BASE_URL = 'https://qt.gtimg.cn'
const DEFAULT_KLINE_BASE_URL = 'https://web.ifzq.gtimg.cn'
const DEFAULT_MKLINE_BASE_URL = 'https://ifzq.gtimg.cn'
const DEFAULT_TIMEOUT_MS = 10_000

export interface TencentRestOptions {
  /** 覆盖报价 base（测试/反代用），末尾不带斜杠。 */
  readonly quoteBaseUrl?: string
  /** 覆盖 K 线 base（测试/反代用），末尾不带斜杠。 */
  readonly klineBaseUrl?: string
  /** 覆盖分钟 K 线 base（测试/反代用），末尾不带斜杠。 */
  readonly mklineBaseUrl?: string
  /** 单请求超时（ms），默认 10s。 */
  readonly timeoutMs?: number
  /** 注入 fetch 实现；缺省用全局 fetch（Node 22+ 内置）。 */
  readonly fetchImpl?: typeof fetch
}

export class TencentRestClient {
  // 纯数据客户端（非 cordis Service 类），可用 # 私有字段（realm 代理风险只涉 Service 基类）。
  readonly #market: TencentMarket
  readonly #quoteBaseUrl: string
  readonly #klineBaseUrl: string
  readonly #mklineBaseUrl: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch

  constructor(market: TencentMarket, options: TencentRestOptions = {}) {
    this.#market = market
    this.#quoteBaseUrl = options.quoteBaseUrl ?? DEFAULT_QUOTE_BASE_URL
    this.#klineBaseUrl = options.klineBaseUrl ?? DEFAULT_KLINE_BASE_URL
    this.#mklineBaseUrl = options.mklineBaseUrl ?? DEFAULT_MKLINE_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  get market(): TencentMarket {
    return this.#market
  }

  async #requestArrayBuffer(url: string): Promise<Uint8Array> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException(`request timed out after ${this.#timeoutMs}ms`, 'TimeoutError')),
      this.#timeoutMs,
    )
    let res: Response
    try {
      res = await this.#fetchImpl(url, { signal: controller.signal })
    } catch (cause) {
      const timedOut = controller.signal.aborted
      throw new TradingServiceError(
        'TRADING_NETWORK',
        timedOut ? `Tencent ${url}: request timed out after ${this.#timeoutMs}ms` : `Tencent ${url}: network error`,
        cause,
      )
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      throw new TradingServiceError(
        res.status === 429 ? 'TRADING_RATE_LIMITED' : 'TRADING_EXCHANGE_ERROR',
        `Tencent ${url}: HTTP ${res.status} ${res.statusText}`,
      )
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  /** 报价 wire 形态：cn=sh600519；hk=r_hk00700（hk K 线另用 hk 前缀，见文件头注）。 */
  #quoteWireCode(symbol: string): string {
    return this.#market === 'hk' ? `r_hk${symbol}` : symbol
  }

  /** K 线 wire 形态：cn=sh600519；hk=hk00700（r_hk 打 K 线端点是 param error，实测）。 */
  #klineWireCode(symbol: string): string {
    return this.#market === 'hk' ? `hk${symbol}` : symbol
  }

  /**
   * 最新行情快照。**GBK 解码**（响应 charset=GBK，UTF-8 直接乱码）；未知代码返回
   * `v_pv_none="1"` 之类短 body，按 TRADING_UNSUPPORTED_SYMBOL 上报。
   */
  async getTicker(symbol: string): Promise<TencentTicker> {
    const sym = normalizeSymbol(this.#market, symbol)
    const url = `${this.#quoteBaseUrl}/q=${this.#quoteWireCode(sym)}`
    const bytes = await this.#requestArrayBuffer(url)
    const text = new TextDecoder('gbk').decode(bytes)
    const m = /="([^"]*)"/.exec(text)
    if (!m) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Tencent ticker for ${sym}: unparseable payload ${JSON.stringify(text.slice(0, 80))} (unknown symbol?)`,
      )
    }
    const fields = m[1].split('~')
    if (fields.length < 35) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Tencent ticker for ${sym}: payload has ${fields.length} fields, expected >= 35 (unknown/delisted symbol?)`,
      )
    }
    const timestamp = this.#market === 'hk'
      ? wallTimeToEpochMs(fields[30] ?? '', 'Asia/Hong_Kong')
      : wallTimeToEpochMs(fields[30] ?? '', 'Asia/Shanghai')
    const parsed = this.#market === 'hk' ? parseHkTicker(fields, timestamp) : parseCnTicker(fields, timestamp)
    // 输出一律规范形（响应体 fields[2] 是裸代码，交易所信息在请求时的 wire 前缀里）。
    return { ...parsed, symbol: toCanonicalTencentSymbol(this.#market, sym) }
  }

  /**
   * K 线（日/周/月走 fqkline 前权 qfq；5m/30m 分钟线走 mkline 端点）。
   * 港股 mkline 端点不支持分钟线，请求 5m/30m 会抛出 TRADING_UNSUPPORTED_INTERVAL。
   */
  async getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    const sym = normalizeSymbol(this.#market, symbol)
    const mapping = INTERVAL_TO_TENCENT.get(interval)
    if (!mapping) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_INTERVAL',
        `Tencent klines: unsupported interval ${String(interval)} — supported: ${INTERVAL_VOCABULARY.join('/')}`,
      )
    }
    if (mapping.type === 'mkline' && this.#market === 'hk') {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_INTERVAL',
        `Tencent klines: Hong Kong market (HKEX) does not support minute intervals (${interval}) via public endpoint`,
      )
    }
    const count = typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 800) : 100
    const wire = this.#klineWireCode(sym)
    const isMinute = mapping.type === 'mkline'
    const url = isMinute
      ? `${this.#mklineBaseUrl}/appstock/app/kline/mkline?param=${wire},${mapping.tf},,${count}`
      : `${this.#klineBaseUrl}/${this.#market === 'hk' ? 'appstock/app/hkfqkline/get' : 'appstock/app/fqkline/get'}?param=${wire},${mapping.tf},,,${count},qfq`

    const bytes = await this.#requestArrayBuffer(url)
    let payload: { code?: number; msg?: string; data?: Record<string, Record<string, unknown>> }
    try {
      payload = JSON.parse(new TextDecoder('utf-8').decode(bytes))
    } catch (cause) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tencent klines for ${sym}: non-JSON payload`, cause)
    }
    if (payload.code !== 0) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Tencent klines for ${sym}: upstream code=${String(payload.code)} msg=${JSON.stringify(payload.msg ?? '')}`,
      )
    }
    const market = payload.data?.[wire]
    // 键回落（2026-08-31 实证，美团 hk03690）：hkfqkline 对无前权事件的代码返回
    // `day`（未复权）而非 `qfqday`——优先 qfq 键，缺失回落裸键，行结构相同。
    const raw = isMinute
      ? market?.[mapping.key]
      : (market?.[mapping.key] ?? market?.[mapping.tf])
    const rows = Array.isArray(raw) ? raw : undefined
    if (rows === undefined || rows.length === 0) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Tencent klines for ${sym}: no ${mapping.key}/${mapping.tf} rows (unknown/delisted symbol?)`,
      )
    }
    const klines: Kline[] = []
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tencent klines for ${sym}: malformed row ${JSON.stringify(row)?.slice(0, 80)}`)
      }
      const open = num(String(row[1]))
      const close = num(String(row[2]))
      const high = num(String(row[3]))
      const low = num(String(row[4]))
      const volume = num(String(row[5]))
      if (open === undefined || close === undefined || high === undefined || low === undefined) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tencent klines for ${sym}: malformed row values ${JSON.stringify(row).slice(0, 80)}`)
      }
      const openTime = isMinute ? minuteKlineTimeToEpochMs(row[0]) : klineDateToEpochMs(row[0])
      klines.push({
        openTime,
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
        closeTime: openTime + mapping.durationMs - 1,
      })
    }
    return klines
  }
}
