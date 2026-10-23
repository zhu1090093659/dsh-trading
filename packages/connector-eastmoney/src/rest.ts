/**
 * @dshtrading/connector-eastmoney/rest
 * 东方财富 A 股公开 REST 行情客户端（免密公共源）。
 */

import type {
  Interval,
  Kline,
  KlineCapability,
  SouthboundHoldingHistory,
  SouthboundHoldingPoint,
  Ticker,
  TradingErrorCode,
} from '@dshtrading/api'
import { HostCircuitBreaker, hostOf, systemClock, type EastmoneyClock } from './resilience.js'

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

/**
 * 能承接的请求深度上限 = 桥的 K 线参数闸门（packages/bot-api MAX_KLINE_LIMIT = 2500）。
 * 5m 及以上走 kline/get，lmt 直通上游且历史深度远超闸门（2026-10-14 实测 klt=5&lmt=1000
 * → 1000 根，spikes/impl-five-day-1m-probe/EVIDENCE.md §3）；1m 走 trends2 窗口型取数
 * （见 getIntradayTrends），同样承接 2500 的请求——返回根数以最近 5 个交易日窗口为界。
 */
export const EASTMONEY_KLINE_MAX_BARS = 2500

/**
 * K 线能力声明（api 可选契约 klineCapabilities）：cn/hk 实例同一集（两条通道的周期面相同）。
 * 1m 的取证 = trends2 ndays=5 是上游唯一的多日 1m 通道（ndays=10 → rc:1），一次给最近
 * 5 个交易日（cn ≈1205 根 / hk ≈1655 根，实测每交易日 cn 241 / hk 331）。
 */
export function eastmoneyKlineCapabilities(): KlineCapability[] {
  return INTERVAL_VOCABULARY.map(interval => ({ interval, maxBars: EASTMONEY_KLINE_MAX_BARS }))
}

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

/**
 * `YYYY-MM-DD[ HH:MM[:SS]]`（UTC+8 墙钟；日 K 只有日期段）→ epoch ms。
 * CN/HK 均为永久 UTC+8，故用固定偏移锚定，与运行机器时区无关（审查 M1：
 * kline/get 此前用 `new Date('YYYY/MM/DD')` 按宿主本地时区解析，TZ≠UTC+8 时
 * 与同市场 1m 序列相差数小时）。
 */
export function utc8WallTimeToEpochMs(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid eastmoney wall time ${JSON.stringify(value)}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) - UTC8_MS
}

/**
 * 东财价格字段的**市场级**分精度倍率：cn ×100，hk ×1000（响应 decimal=3）。
 * 它只是 f1 缺失时的兜底——报价行自带 f1 = 该标的小数位数，且股票与 ETF 不同档
 * （2026-10-14 实测：cn 股票 f1=2 而 cn ETF / hk 均 f1=3），故取值一律走按行的
 * quotePriceScale()，市场级常数对 A 股 ETF 会差 10 倍。
 */
export function eastmoneyPriceScale(market: EastmoneyMarket): number {
  return market === 'hk' ? 1000 : 100
}

/**
 * `YYYY-MM-DD[ ...]`（报表日期列为 UTC+8 零点的墙钟串，如 `2026-10-09 00:00:00`）
 * → **UTC 当日 00:00** 的 epoch ms（与日 K openTime 同口径，便于前向对齐）。
 * 只取日期段，用 Date.UTC 构造，不引入运行机器的本地时区偏移。
 */
export function parseReportDateToUtcMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (m === null) return undefined
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(ms) ? ms : undefined
}

/** 报表数值列 → 有限数；null/空串/非数值返回 undefined（调用方决定跳过还是兜底）。 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 报价行的价格除数 = 10^f1（f1 = 上游给该标的声明的小数位数）。按行取值才同时对
 * 股票与 ETF 成立：2026-10-14 逐只与腾讯 qt.gtimg.cn 交叉验证——游戏ETF华夏 f1=3 →
 * f2=1058 即 1.058 元（腾讯 1.058）、东瑞股份 f1=2 → f2=1413 即 14.13 元（腾讯 14.13）、
 * 腾讯控股 f1=3 → f2=426200 即 426.2 港元。f1 缺失或超出 0..6 时回落到市场级常数。
 */
function quotePriceScale(decimalDigits: unknown, market: EastmoneyMarket): number {
  const digits = toFiniteNumber(decimalDigits)
  if (digits === undefined || !Number.isInteger(digits) || digits < 0 || digits > 6) {
    return eastmoneyPriceScale(market)
  }
  return 10 ** digits
}

/**
 * 报价行 → Ticker 快照（单标的 `getTicker` 与批量 `getTickers` 共用同一个解析器，避免养出
 * 第二套取价逻辑）：价格与昨收都按**该行**的 f1 取除数，涨跌幅走 ×100；f14 缺失或空白时不带 name。
 */
function parseQuoteRow(row: Record<string, unknown>, canonical: string, market: EastmoneyMarket): Ticker {
  const scale = quotePriceScale(row.f1, market)
  const rawPrice = parseScaled(row.f2, scale) ?? 0
  const price = rawPrice > 0 ? rawPrice : 0
  const volume = toFiniteNumber(row.f5) ?? 0
  const quoteTime = toFiniteNumber(row.f124)
  const timestamp = quoteTime !== undefined && quoteTime > 0 ? quoteTime * 1000 : Date.now()
  // 官方昨收锚点（与 tencent fields[4] 同语义）：涨跌幅基准，UI 头部/侧栏直接消费。
  const prevClose = parseScaled(row.f18, scale)
  const changePercent = parseScaledHundred(row.f3)

  const name = typeof row.f14 === 'string' && row.f14.trim() ? row.f14.trim() : undefined

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

/**
 * 报价行 → 它自己的 secid（f13=市场 + f12=代码）。批量路径靠它把响应行还原成请求时算出的
 * secid，**不依赖上游返回顺序**；两列任一缺失就弃掉这一行（宁可少一只标的，也不把行错配给
 * 别的符号）。f12 正常是已补零的字符串（cn `002714` / hk `00700`），数值形照 String 处理。
 */
function quoteRowSecid(row: Record<string, unknown>): string | undefined {
  const market = toFiniteNumber(row.f13)
  const code = typeof row.f12 === 'string' ? row.f12.trim()
    : typeof row.f12 === 'number' ? String(row.f12)
      : ''
  if (market === undefined || !Number.isInteger(market) || code === '') return undefined
  return `${market}.${code}`
}

/**
 * 将标准代码转为东财 secid。**按连接器市场分流**（2026-09-08 审查 H3/L1）：同一个
 * 东财服务实例可能服务 cn 或 hk，形态解析必须知道自己是哪个市场——否则港股宽容
 * 形 `700` 会落进 CN 兜底（secid 0.700 / canonical 700.SZ），查询到另一个市场
 * 的证券且回带错误规范形。
 *
 * - `market='hk'`：`00700.HK` / `HK.00700`（Futu 原生形）/ `HK00700` / 裸 1-5 位
 *   数字 → secid 116.xxxxx；CN 形态（6 位数字 / .SH/.SZ/.BJ）显式拒绝。
 * - `market='cn'`：6 位数字（可带 .SH/.SZ/.BJ）→ 1.xxxxxx（沪）/ 0.xxxxxx（深、
 *   北）；HK 形态显式拒绝。
 */
export function toEastmoneySecid(symbol: string, market: EastmoneyMarket = 'cn'): { secid: string; canonical: string; market: EastmoneyMarket } {
  const clean = symbol.trim().toUpperCase()
  if (market === 'hk') {
    const hkMatch = /^(\d{1,5})\.HK$/.exec(clean) ?? /^HK\.?(\d{1,5})$/.exec(clean) ?? /^(\d{1,5})$/.exec(clean)
    if (hkMatch === null) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Eastmoney hk: malformed HK symbol ${JSON.stringify(symbol)}`)
    }
    const hkCode = (hkMatch[1] as string).padStart(5, '0')
    return { secid: `116.${hkCode}`, canonical: `${hkCode}.HK`, market: 'hk' }
  }
  if (/^\d{1,5}$/.test(clean) || /\.HK$/.test(clean) || /^HK/.test(clean)) {
    throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Eastmoney cn: not an A-share symbol ${JSON.stringify(symbol)}`)
  }
  let code = clean
  let exchange = ''

  if (clean.includes('.')) {
    const parts = clean.split('.')
    code = parts[0] as string
    exchange = parts[1] as string
  } else if (/^\d{6}$/.test(clean)) {
    code = clean
    if (KNOWN_SH_INDICES.has(code) || code.startsWith('6') || code.startsWith('5') || code.startsWith('9')) {
      exchange = 'SH'
    } else if (code.startsWith('0') || code.startsWith('3') || code.startsWith('1')) {
      exchange = 'SZ'
    } else if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) {
      exchange = 'BJ'
    }
  }

  if (!exchange) {
    if (KNOWN_SH_INDICES.has(code) || code.startsWith('6') || code.startsWith('5')) exchange = 'SH'
    else exchange = 'SZ'
  }

  const prefix = exchange === 'SH' ? '1' : '0'
  return {
    secid: `${prefix}.${code}`,
    canonical: `${code}.${exchange}`,
    market: 'cn',
  }
}

/**
 * 请求通道的硬上界（2026-10-23 实测口径，见 .agents/notes/implemented/bug-fix/
 * 2026-10-23-tencent-kline-host-fallback-and-eastmoney-network-retry.md）：单枪超时、枪数上界、
 * 固定冷却、一次取数整通硬截止、熔断窗口。每个都是硬数字，不随负载或失败次数变化。
 */
const DEFAULT_TIMEOUT_MS = 2_000
const MAX_ATTEMPTS = 3
const RETRY_COOLDOWN_MS = 200
const REQUEST_BUDGET_MS = 3_000
const CIRCUIT_OPEN_MS = 30_000

export interface EastmoneyRestOptions {
  baseUrl?: string
  historyBaseUrl?: string
  searchBaseUrl?: string
  /** 东财数据中心域（datacenter-web，报表类端点；与 push2 行情域分离）。 */
  dataCenterBaseUrl?: string
  fetchImpl?: typeof fetch
  /** 本实例服务的市场（形态解析与价格倍率都按它分流；缺省 cn）。 */
  market?: EastmoneyMarket
  /** 单枪超时（ms），缺省 2000：挂住的请求到点 abort 成 TRADING_NETWORK，不存在无上界的等待。 */
  timeoutMs?: number
  /** 时钟注入（固定冷却的 sleep 与整通硬截止计时都读它）；缺省真实 timer。 */
  clock?: EastmoneyClock
}

/**
 * 东财数据中心「返回数据为空」业务码（2026-10-13 实测）：非港股通标的与
 * pageNumber 越界都返回 `{ result: null, success: false, code: 9201,
 * message: "返回数据为空" }`，HTTP 200。它不是故障，是「该标的无此序列」，
 * 必须与故障区分——其余非零码（实测 9501：报表配置不存在 / 列不存在）是
 * 上游协议错误，要抛错而不是当成空序列。
 */
const DATACENTER_EMPTY_CODE = 9201

/** 数据中心报表端点的 Referer（该域校验 data.eastmoney.com，与 push2 的 quote 域不同）。 */
const DATACENTER_REFERER = 'https://data.eastmoney.com/'

/**
 * 1m 的 trends2 取数窗口 = 最近 5 个交易日（2026-10-14 实测，spikes/impl-five-day-1m-probe/）：
 * ndays=5 是上游上限（ndays=10 → rc:1），单次返回 cn 约 1205 根 / hk 约 1655 根
 * （实测每个交易日 cn 241 根、hk 331 根）。
 */
const TRENDS_NDAYS = 5

/**
 * 把重建出的开价收敛进当根 [low, high]：真实分钟 bar 恒有 low <= open <= high，
 * 故越界的候选值一定偏离真值，夹到最近边界比放它出去更接近真值（也避免实体戳出影线）。
 * low/high 非有限值或 low > high（上游坏行）时原样返回，不做改写。
 */
function clampToBarRange(value: number, low: number, high: number): number {
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return value
  return Math.min(Math.max(value, low), high)
}

/**
 * 报价行字段（ulist.np/get）：f1=小数位数 f2=最新价 f3=涨跌幅(%) f5=成交量(手)
 * f12=代码 f13=市场 f14=名称 f18=昨收 f124=行情时间(秒)。价格类字段是 ×10^f1 的整数。
 */
const QUOTE_FIELDS = 'f1,f2,f3,f5,f12,f13,f14,f18,f124'

/**
 * 降级派生快照的缓存 TTL（2026-10-14）：侧栏每 8s 一拍、每拍对每只自选取一次价；报价路径不可用
 * 时若每拍都派生，就是把每只标的每分钟 7+ 次请求压到**同源**的 push2his 上——那是把仅存的那条
 * 路也打穿。60s 内同一 secid 只允许一次 trends2。缓存**只在降级分支读写**：报价路径恢复即返回
 * 直取的新鲜值，绝不用陈旧派生值顶替它。
 */
const DERIVED_QUOTE_TTL_MS = 60_000

/**
 * trends2 响应骨架（派生快照用）：`data` 顶层自带该标的的 name/decimal/preClose，与当日分钟序列
 * 同在一条响应里（2026-10-14 实测：cn 241 根 / hk 331 根 / 15.9 KB），故派生快照的名称与昨收
 * 不必再取第二个端点。
 */
interface EastmoneyTrendsResponse {
  data?: { name?: unknown; preClose?: unknown; trends?: unknown } | null
}

/** ulist.np/get 响应骨架：命中的行在 data.diff；未收录的 secid 使 data 为 null。 */
interface EastmoneyQuoteListResponse {
  data?: { total?: number; diff?: Array<Record<string, unknown>> } | null
}

/** 批量报价的请求表：secid → 该 secid 的规范形 + 入参里指向它的全部原字符串。 */
interface RequestedQuote {
  canonical: string
  originals: string[]
}

/**
 * 「首选取价路径不可用」判定：只有网络故障与上游错误才降级派生。`TRADING_SYMBOL_NOT_FOUND` /
 * `TRADING_UNSUPPORTED_SYMBOL` 是关于**标的**的事实、不是取价路径的故障，一律照实上报
 * （@dshtrading/api 的 Ticker 契约明令降级不得掩盖它们）。
 */
function isQuotePathUnavailable(err: unknown): err is TradingServiceError {
  return err instanceof TradingServiceError
    && (err.code === 'TRADING_NETWORK' || err.code === 'TRADING_UPSTREAM_ERROR')
}

/** 数据中心 /api/data/v1/get 响应骨架（列名随报表而变，data 行按需解析）。 */
interface EastmoneyDataCenterResponse {
  success?: boolean
  code?: number
  message?: string
  result?: { data?: unknown; count?: number; pages?: number } | null
}

export class EastmoneyRestClient {
  readonly baseUrl: string
  readonly historyBaseUrl: string
  readonly searchBaseUrl: string
  /** 东财数据中心域（港股通持股等报表端点）。 */
  readonly dataCenterBaseUrl: string
  /** 本实例的市场（cn/hk 单包双实例；形态解析必须与注册市场一致）。 */
  readonly market: EastmoneyMarket
  private readonly fetchImpl: typeof fetch
  /** 单枪超时（ms）。 */
  private readonly timeoutMs: number
  /** 请求通道时钟（冷却与整通截止）。 */
  private readonly clock: EastmoneyClock
  /** 按主机的短期熔断（一次整通网络级失败后该主机静默 CIRCUIT_OPEN_MS）。 */
  private readonly circuit = new HostCircuitBreaker()
  /** 降级派生快照的 60s TTL 缓存（键=secid；只在降级分支读写，见 DERIVED_QUOTE_TTL_MS）。 */
  private readonly derivedQuoteCache = new Map<string, { ticker: Ticker; expiresAt: number }>()

  constructor(options: EastmoneyRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://push2.eastmoney.com'
    this.historyBaseUrl = options.historyBaseUrl ?? 'https://push2his.eastmoney.com'
    this.searchBaseUrl = options.searchBaseUrl ?? 'https://searchapi.eastmoney.com'
    this.dataCenterBaseUrl = options.dataCenterBaseUrl ?? 'https://datacenter-web.eastmoney.com'
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.market = options.market ?? 'cn'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.clock = options.clock ?? systemClock
  }

  /**
   * 单次 GET + JSON，带**单枪超时**：超时盖的是**整枪**——建连、响应头与**响应体解析**合成一个
   * promise 与超时竞速（照 connector-tencent 的 #fetchWithTimeout 的 timeoutMs + AbortController
   * 范式，并补上那边只盖到 fetch 返回、没盖住 body 读取的缺口）。到点以 TRADING_NETWORK +
   * `request timed out after <n>ms` 终结这一枪且保持可重试，故「200 头已到、body 永不结束」这类
   * 挂住同样受 3 枪上界与整通硬截止约束，不存在无上界的等待。
   *
   * 网络级异常（undici `fetch failed` / 服务端收到即断的空回 / 超时）抛 TRADING_NETWORK 并标为
   * 可重试；HTTP 非 2xx 抛 TRADING_UPSTREAM_ERROR、解析失败抛 TRADING_NETWORK（后两者不可重试
   * ——4xx/5xx 与 WAF/HTML 错误页不是主机抖动）。
   */
  private async requestOnce<T>(
    url: string,
    referer: string,
    timeoutMs: number,
  ): Promise<
    | { readonly ok: true; readonly body: T }
    | { readonly ok: false; readonly retryable: boolean; readonly error: TradingServiceError }
  > {
    type Attempt =
      | { readonly ok: true; readonly body: T }
      | { readonly ok: false; readonly retryable: boolean; readonly error: TradingServiceError }

    /** 超时口径的唯一出口：可重试，消息带毫秒数，便于把事故归因到本枪。 */
    const timedOut = (): Attempt => ({
      ok: false,
      retryable: true,
      error: new TradingServiceError(
        'TRADING_NETWORK',
        `Eastmoney network error: request timed out after ${timeoutMs}ms`,
      ),
    })

    const controller = new AbortController()

    // 整枪 = 建连 + 响应头 + 响应体解析。abort 照发（真实 fetch 靠它释放连接），但超时的判定
    // 不依赖它——注入的 fetchImpl、以及已经返回的 Response，都不受我们自己造的 signal 约束。
    const attempt = async (): Promise<Attempt> => {
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
            'Referer': referer,
          },
          signal: controller.signal,
        })
      } catch (err) {
        if (controller.signal.aborted) return timedOut()
        return {
          ok: false,
          retryable: true,
          error: new TradingServiceError(
            'TRADING_NETWORK',
            `Eastmoney network error: ${err instanceof Error ? err.message : String(err)}`,
            err,
          ),
        }
      }
      if (!res.ok) {
        return {
          ok: false,
          retryable: false,
          error: new TradingServiceError(
            'TRADING_UPSTREAM_ERROR',
            `Eastmoney HTTP request failed: status ${res.status} ${res.statusText}`,
          ),
        }
      }
      try {
        return { ok: true, body: await res.json() as T }
      } catch (err) {
        // 超时 abort 会让 body 读取直接报错：按超时口径（可重试）终结，不降级成「坏 JSON」。
        if (controller.signal.aborted) return timedOut()
        return {
          ok: false,
          retryable: false,
          error: new TradingServiceError(
            'TRADING_NETWORK',
            `Eastmoney network error: ${err instanceof Error ? err.message : String(err)}`,
            err,
          ),
        }
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Attempt>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException(`request timed out after ${timeoutMs}ms`, 'TimeoutError'))
        resolve(timedOut())
      }, timeoutMs)
    })

    try {
      // 竞速而非「只给 fetch 挂定时器」：先拿到结果的一方说了算，超时到点即终结整枪。落败的
      // attempt 其后续结果被丢弃，但它不会留下悬挂 timer——定时器在 finally 里统一撤销。
      return await Promise.race([attempt(), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 取 JSON：**有界重试 + 按主机短期熔断**（2026-10-23 二次实测口径）。
   *
   * 实测形态是「连接建立之后的 HTTP 空回」（connect 3ms 级成功、total 0.15-0.31s、curl (52)
   * Empty reply / http=000 bytes=0），不是 connect 失败也不是超时；最长连败 6 枪跨 22.7 秒，
   * 恢复一次后又再度失败。故：
   *   - 只有网络级可重试失败才重试，最多 MAX_ATTEMPTS 枪（硬上界 3）；
   *   - 重试之间是**固定**冷却 RETRY_COOLDOWN_MS（不是退避、不递增）；
   *   - 一次取数整通有硬截止 REQUEST_BUDGET_MS（含冷却与全部枪）：剩不下「一次冷却 + 下一枪」
   *     就直接收尾，枪不会越过截止点，也就不存在续命；
   *   - 整通失败后把**该主机**记进熔断窗口 CIRCUIT_OPEN_MS，窗口内对该主机的调用零网络请求
   *     立即抛 TRADING_NETWORK，到期自动恢复，任一成功即清零；
   *   - HTTP 非 2xx 与 JSON 解析失败不可重试、也**不打开**熔断（一个 404/WAF 页不是主机故障）。
   */
  private async requestJson<T>(url: string, referer: string = 'https://quote.eastmoney.com/'): Promise<T> {
    const host = hostOf(url)
    const openForMs = this.circuit.remaining(host, this.clock.now())
    if (openForMs !== undefined) {
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Eastmoney ${host}: circuit open, ${openForMs}ms remaining`,
      )
    }

    const deadlineAt = this.clock.now() + REQUEST_BUDGET_MS
    let lastError: TradingServiceError | undefined
    for (let shot = 1; shot <= MAX_ATTEMPTS; shot += 1) {
      // 硬截止：剩余预算不为正就不打这一枪（含首枪之外的每一枪）。
      const remainingMs = deadlineAt - this.clock.now()
      if (remainingMs <= 0) break
      // 单枪超时吃掉的预算与整通截止取小值：任一枪都不可能把整通拖过截止点。
      const result = await this.requestOnce<T>(url, referer, Math.min(this.timeoutMs, remainingMs))
      if (result.ok) {
        this.circuit.clear(host)
        return result.body
      }
      // 非 2xx / 解析失败：就地抛，不重试、不打开熔断。
      if (!result.retryable) throw result.error
      lastError = result.error
      if (shot === MAX_ATTEMPTS) break
      // 固定冷却，且必须整段装进剩余预算；装不下就认定整通失败，不缩短冷却硬挤一枪。
      if (deadlineAt - this.clock.now() <= RETRY_COOLDOWN_MS) break
      await this.clock.sleep(RETRY_COOLDOWN_MS)
    }

    this.circuit.trip(host, this.clock.now(), CIRCUIT_OPEN_MS)
    throw lastError ?? new TradingServiceError('TRADING_NETWORK', `Eastmoney ${host}: request budget exhausted`)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { secid, canonical, market } = toEastmoneySecid(symbol, this.market)
    // 报价走批量端点 ulist.np/get（secids 传单个 secid 等价）：2026-10-14 实测 push2 与
    // push2his 的 /api/qt/stock/get 对任意 secid 都空回（curl: (52) Empty reply from
    // server），而同一时刻、同域、同 UA 的 ulist.np/get 与 kline/trends2/search 全部正常
    // ——单标的报价端点没了，不是网络故障。原始证据见 spikes/impl-eastmoney-quote-endpoint/。
    const url = `${this.baseUrl}/api/qt/ulist.np/get?secids=${secid}&fields=${QUOTE_FIELDS}`
    try {
      const res = await this.requestJson<EastmoneyQuoteListResponse>(url)
      const row = res.data?.diff?.[0]

      // 未收录的 secid 上游返回 data:null；有效与无效混传时只少返回行、HTTP 仍 200，
      // 故「拿不到行」即该标的不存在，按 not found 抛错（与该端点原 data 为空的语义一致）。
      if (row === undefined) {
        throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Eastmoney symbol not found: ${symbol}`)
      }

      return parseQuoteRow(row, canonical, market)
    } catch (err) {
      // 只有取价路径不可用才降级；not-found / unsupported 照实抛出（见 isQuotePathUnavailable）。
      if (!isQuotePathUnavailable(err)) throw err
      return this.derivedQuote(secid, canonical, err)
    }
  }

  /**
   * 批量最新报价：一次 `ulist.np/get` 取多只标的（契约见 @dshtrading/api 的
   * `MarketDataService.getTickers`），把自选栏「N 只标的 N 次请求」压成 1 次。本连接器
   * **不分片**——单次请求的标的数由调用方裁剪（桥侧 MAX_SYMBOLS）。
   *
   * 三个语义要点：
   *   - 键是**入参原字符串**：同一 secid 的多种写法（`600519` / `600519.SH`）各占一个键，
   *     共享同一份快照；`Ticker.symbol` 仍是规范形；
   *   - 行→符号靠响应行的 f13+f12 拼回 secid 再查请求表，**与上游返回顺序无关**；
   *   - 只返回确实拿到的标的：转不成 secid 的符号、以及 diff 里缺行的符号都不出现在结果里
   *     （调用方按缺失回落单取，保住各符号自己的错误码）；整批 HTTP/网络失败才抛出。
   *   - 整批失败时若有「降级派生」可用（见 derivedQuote），逐只派生而不是整批报废；一只都派生
   *     不出来仍抛原始错误（2026-10-14 东财封报价路径后的活口）。
   */
  async getTickers(symbols: string[]): Promise<Record<string, Ticker>> {
    if (symbols.length === 0) return {}

    // secid → 该 secid 的规范形，以及入参里指向它的全部原字符串（同一标的的多种写法共享一份快照）。
    const requested = new Map<string, RequestedQuote>()
    for (const symbol of symbols) {
      let mapped: { secid: string; canonical: string }
      try {
        mapped = toEastmoneySecid(symbol, this.market)
      } catch {
        // 跨市场形态/畸形符号转不成 secid → 跳过该符号，整批不失败。
        continue
      }
      const hit = requested.get(mapped.secid)
      if (hit === undefined) requested.set(mapped.secid, { canonical: mapped.canonical, originals: [symbol] })
      else hit.originals.push(symbol)
    }
    // 入参里没有一只能转成 secid：没有可发的请求，直接空手而归。
    if (requested.size === 0) return {}

    const url = `${this.baseUrl}/api/qt/ulist.np/get?secids=${[...requested.keys()].join(',')}&fields=${QUOTE_FIELDS}`
    let res: EastmoneyQuoteListResponse
    try {
      res = await this.requestJson<EastmoneyQuoteListResponse>(url)
    } catch (err) {
      // 批量报价路径不可用 → 逐只派生（同一 secid 60s 内最多一次 trends2，见 DERIVED_QUOTE_TTL_MS）。
      if (!isQuotePathUnavailable(err)) throw err
      return this.deriveTickers(requested, err)
    }

    // data 为 null / 无 diff 是「一个都没收录」（只传无效 secid 的响应形态），不是故障——按契约空返回。
    const rows: unknown[] = Array.isArray(res.data?.diff) ? (res.data?.diff as unknown[]) : []
    const out: Record<string, Ticker> = {}
    for (const raw of rows) {
      if (raw === null || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      const secid = quoteRowSecid(row)
      if (secid === undefined) continue
      const hit = requested.get(secid)
      // 响应里出现没请求过的 secid（或两列无法拼回）：不认这行，绝不把它错配给别的符号。
      if (hit === undefined) continue
      const ticker = parseQuoteRow(row, hit.canonical, this.market)
      for (const original of hit.originals) out[original] = ticker
    }
    return out
  }

  /**
   * 批量报价路径不可用时的逐只降级：对**请求表里的每个 secid** 各取一次派生快照（TTL 内命中缓存
   * 的不发请求）；转不成 secid 的符号根本没进请求表，仍按契约跳过、整批不失败。
   *
   * 一只都派生不出来时抛回**原始**错误——空表在 getTickers 契约里是「一个都没收录」，与「整批
   * 取数失败」语义完全不同，降级不得把后者改写成前者。只要拿到了一部分，就按既有语义只返回拿到
   * 的那些（缺的由调用方回落 `getTicker`，拿它们各自的错误码）。
   */
  private async deriveTickers(requested: Map<string, RequestedQuote>, cause: TradingServiceError): Promise<Record<string, Ticker>> {
    const out: Record<string, Ticker> = {}
    for (const [secid, hit] of requested) {
      let ticker: Ticker
      try {
        ticker = await this.derivedQuote(secid, hit.canonical, cause)
      } catch {
        continue
      }
      for (const original of hit.originals) out[original] = ticker
    }
    if (Object.keys(out).length === 0) throw cause
    return out
  }

  /**
   * 降级取价：60s TTL 缓存（键=secid，故 `002714` 与 `002714.SZ` 共享同一份）+ 失败兜底。
   * 派生本身失败（trends2 也失败 / 没有行情行）说明这个源眼下整个不可用——抛回**原始**错误码，
   * 绝不吞成 not-found、也绝不交出一条空快照。返回浅拷贝，不把缓存对象交给消费方改写。
   */
  private async derivedQuote(secid: string, canonical: string, cause: TradingServiceError): Promise<Ticker> {
    const hit = this.derivedQuoteCache.get(secid)
    // canonical 是 secid 的纯函数（toEastmoneySecid），同一 secid 的缓存快照对任何入参写法都成立。
    if (hit !== undefined && hit.expiresAt > Date.now()) return { ...hit.ticker }

    let ticker: Ticker
    try {
      ticker = await this.deriveQuoteFromTrends(secid, canonical)
    } catch {
      throw cause
    }
    this.derivedQuoteCache.set(secid, { ticker, expiresAt: Date.now() + DERIVED_QUOTE_TTL_MS })
    return ticker
  }

  /**
   * 报价路径不可用时的降级快照：走**同源**（push2his，与 kline/trends2 同域；2026-10-14 实测
   * 报价域被封时它仍 200）的当日分钟序列，末根收盘价即最新价。
   *
   * 2026-10-14 实测（spikes/impl-eastmoney-quote-endpoint/p3）：
   *   - 该响应的价格**已是十进制值**——cn 0.002714 末根 `2026-10-14 15:00,41.07,40.89,41.07,
   *     40.89,5411,22125210.00,41.081` → 40.89，与同刻腾讯报价逐位一致，`data.preClose`=40.9
   *     = 腾讯昨收；故**不再**除 10^decimal（×10^f1 是报价端点 ulist.np/get 的整数口径，不是这条的）；
   *   - `data` 顶层自带 name/preClose，名称、昨收与价格取自同一条响应；
   *   - changePercent 由同一对 price/prevClose 推出（序列里没有涨跌幅字段，也不另取端点），
   *     保证「派生值自洽」；
   *   - **不给 volume**：窗口第 6 列之和在 cn 等于当日累计（196239 = 日 K 196239），但 hk 低于
   *     当日累计（18,418,300 vs 19,933,548，缺 16:00 后收市竞价）——拿不到的量宁可缺省
   *     （`Ticker.volume` 本就可选），不用窗口合计之类的近似值冒充当日累计。
   */
  private async deriveQuoteFromTrends(secid: string, canonical: string): Promise<Ticker> {
    const url = `${this.historyBaseUrl}/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0`
    const res = await this.requestJson<EastmoneyTrendsResponse>(url)
    const data = res.data
    const trends = data?.trends
    const last = Array.isArray(trends) ? trends[trends.length - 1] : undefined
    // 没有行情行（停牌 / 未收录 / 上游给了空窗口）→ 派生不成立，由 derivedQuote 抛回原始错误。
    if (typeof last !== 'string') {
      throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Eastmoney trends2 returned no intraday rows for ${secid}`)
    }

    const parts = last.split(',')
    const price = parseFloat(parts[2] ?? '')
    if (!Number.isFinite(price) || price <= 0) {
      throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Eastmoney trends2 last row has no usable close for ${secid}`)
    }

    const prevClose = toFiniteNumber(data?.preClose)
    const rawName = data?.name
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined
    // 昨收缺失或非正时不给涨跌幅：宁可缺省，也不用半个基准编一个百分数出来。
    const changePercent = prevClose !== undefined && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : undefined

    return {
      symbol: canonical,
      ...(name ? { name } : {}),
      price,
      // 末根时间按 UTC+8 墙钟换算，与同市场 1m/K 线同口径，与宿主本地时区无关。
      timestamp: utc8WallTimeToEpochMs(parts[0] ?? ''),
      ...(prevClose !== undefined && prevClose > 0 ? { prevClose } : {}),
      ...(changePercent !== undefined ? { changePercent } : {}),
    }
  }

  /** K 线能力声明（api 可选契约）：cn/hk 实例同一集，口径见 eastmoneyKlineCapabilities。 */
  klineCapabilities(): readonly KlineCapability[] {
    return eastmoneyKlineCapabilities()
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { secid } = toEastmoneySecid(symbol, this.market)
    // 1m 对 cn 与 hk 都走 trends2：kline/get 的 klt=1 只有当日（实测 lmt 与 end 均被
    // 上游忽略），多日窗口的唯一通道是 trends2 的 ndays；5m 及以上仍走 kline/get。
    if (interval === '1m') {
      return this.getIntradayTrends(secid, limit)
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

      // UTC+8 固定偏移锚定（审查 M1）：与同市场 1m（trends2）同口径，机器时区无关。
      let openTime: number
      try {
        openTime = utc8WallTimeToEpochMs(timeStr)
      } catch {
        continue
      }

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
   * trends2 分时序列（最近 TRENDS_NDAYS 个交易日的全天分钟序列，非交易日自然回落到
   * 最近交易日；cn/hk 共用）。行格式同 kline/get：`时间,开,收,高,低,量,额,均价`；
   * 时间为 'YYYY-MM-DD HH:MM' 的 UTC+8 墙钟，序列按时间升序。
   *
   * 开价的派生语义（2026-10-14 实测，spikes/impl-five-day-1m-probe/）：ndays>1 时上游
   * 只给「当日」那一段真实开价，历史交易日每根的第 2 列恒为 0.00（cn 241/241、hk 331/331
   * 全为 0），close 与腾讯 m1 逐根一致、high/low 有 ≤0.5 的舍入差。因此：
   *   - 上游 open > 0：用上游值（当日、以及非当日偶发的真实值），不做任何改写；
   *   - 上游 open = 0：重建 + clamp——候选值是同日前一根的 close（1m 粒度下，前一根收盘
   *     是该分钟开盘价最佳可得近似；每个交易日首根没有同日前一根，取该根自身 close，不把
   *     上游未给出的跨日缺口算进来，午后首根用的是午休前最后一根的 close，午休不移动价格），
   *     再 clamp 进**当根** [low, high]：真实分钟 bar 恒有 low <= open <= high，该分钟真实
   *     开价必然落在自身高低区间内，clamp 比原候选更接近真值，也避免实体戳出影线。
   *     low/high 非有限值或 low > high 时保留候选值（上游坏行不强行改写）。
   * 重建后的 open 仍是派生值而非取数，但已保证自洽：2026-10-14 五日窗口实测，clamp 前
   * 有 cn 242/1007、hk 28/1367 根越界（多数是最小变动价位量级，单根最大 cn 2.99 元，来自
   * 2026-10-09 09:31 的分钟边界跳空），clamp 后越界 0 根（spikes/impl-five-day-1m-fetch/）。
   */
  private async getIntradayTrends(secid: string, limit: number): Promise<Kline[]> {
    const url = `${this.historyBaseUrl}/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=${TRENDS_NDAYS}&iscr=0`
    const res = await this.requestJson<{ data?: { trends?: string[] } }>(url)
    const trends = res.data?.trends
    if (!Array.isArray(trends)) return []

    const stepMs = parseIntervalMs('1m')
    const klines: Kline[] = []
    let prevDay = ''
    let prevClose = 0
    for (const line of trends) {
      const parts = line.split(',')
      if (parts.length < 6) continue
      const timeStr = parts[0] ?? ''
      const day = timeStr.slice(0, 10)
      const close = parseFloat(parts[2] ?? '')
      const high = parseFloat(parts[3] ?? '')
      const low = parseFloat(parts[4] ?? '')
      const upstreamOpen = parseFloat(parts[1] ?? '')
      const open = upstreamOpen > 0
        ? upstreamOpen
        : clampToBarRange(day === prevDay && prevClose > 0 ? prevClose : close, low, high)

      let openTime: number
      try {
        openTime = utc8WallTimeToEpochMs(timeStr)
      } catch {
        continue
      }

      klines.push({
        openTime,
        open,
        high,
        low,
        close,
        volume: parseFloat(parts[5] ?? ''),
        closeTime: openTime + stepMs - 1,
      })
      prevDay = day
      prevClose = close
    }
    return klines.slice(-Math.max(limit, 1))
  }

  async listInstruments(query?: string): Promise<Array<{ symbol: string; name: string }>> {
    if (!query) return []
    const url = `${this.searchBaseUrl}/api/suggest/get?input=${encodeURIComponent(query)}&type=14`
    const res = await this.requestJson<{ QuotationCodeTable?: { Data?: Array<{ Code: string; Name: string; SecurityTypeName: string }> } }>(url)
    const items = res.QuotationCodeTable?.Data ?? []
    const out: Array<{ symbol: string; name: string }> = []
    for (const item of items) {
      // 搜索结果可能混入其它市场形态：映射不了就跳过（不让一条坏行毁掉整份名册）。
      try {
        const { canonical } = toEastmoneySecid(item.Code, this.market)
        out.push({ symbol: canonical, name: item.Name })
      } catch {
        continue
      }
    }
    return out
  }

  /**
   * 港股通持股历史（东财数据中心 RPT_MUTUAL_STOCK_HOLDRANKS，2026-10-13）。
   *
   * 只覆盖港股通标的：标的无该序列时返回空 points（**空 ≠ 0**，消费方隐藏副图
   * 而不是画一条贴底的假线）；上游网络/协议失败抛错。仅 hk 实例可用——该报表以
   * 5 位港股代码为主键，cn 实例调用即协议误用。
   */
  async getSouthboundHoldings(symbol: string): Promise<SouthboundHoldingHistory> {
    if (this.market !== 'hk') {
      throw new TradingServiceError(
        'TRADING_NOT_IMPLEMENTED',
        `Eastmoney southbound holdings is an hk-only capability (instance market: ${this.market})`,
      )
    }
    const { canonical } = toEastmoneySecid(symbol, this.market)
    // 报表主键是不带后缀的 5 位港股代码（00700）；规范形带 .HK 后缀，此处剥掉。
    const code = canonical.slice(0, canonical.indexOf('.'))
    // MUTUAL_TYPE 002/004 每交易日各一行且数值相同；(MUTUAL_TYPE="002") 让单页拿全
    // 历史并天然去重，本地仍按 HOLD_DATE 再兜一次。
    const filter = `(SECURITY_CODE="${code}")(MUTUAL_TYPE="002")`
    const url = `${this.dataCenterBaseUrl}/api/data/v1/get?reportName=RPT_MUTUAL_STOCK_HOLDRANKS&columns=ALL`
      + `&filter=${encodeURIComponent(filter)}&pageSize=1000&pageNumber=1`
      + '&sortColumns=HOLD_DATE&sortTypes=1&source=WEB&client=WEB'
    const res = await this.requestJson<EastmoneyDataCenterResponse>(url, DATACENTER_REFERER)

    // 只有「返回数据为空」是合法空序列；其余业务错误码（如 9501 报表/列不存在）是上游故障。
    if (res.success === false && res.code !== DATACENTER_EMPTY_CODE) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        `Eastmoney datacenter error: code ${res.code ?? 'unknown'} ${res.message ?? ''}`.trim(),
      )
    }
    const result = res.result
    if (result === null || result === undefined) return { symbol: canonical, points: [] }
    const rows = result.data
    if (rows === null || rows === undefined) return { symbol: canonical, points: [] }
    if (!Array.isArray(rows)) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        `Eastmoney datacenter malformed payload: result.data is ${typeof rows}`,
      )
    }
    // 单页装不下即整段历史不可信：宁可抛错让消费方隐藏副图，也不静默给半截序列。
    if (typeof result.pages === 'number' && result.pages > 1) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        `Eastmoney datacenter pagination overflow: ${rows.length} rows in page 1 of ${result.pages}`,
      )
    }

    const byDate = new Map<number, SouthboundHoldingPoint>()
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      const ratio = toFiniteNumber(record.HOLD_SHARES_RATIO)
      // 比例缺失的行直接跳过（绝不当 0——那会画出一条贴底假线）；比例是本副图唯一取值列。
      if (ratio === undefined) continue
      const date = parseReportDateToUtcMs(record.HOLD_DATE)
      if (date === undefined) continue
      if (byDate.has(date)) continue
      byDate.set(date, {
        date,
        holdRatio: ratio,
        holdShares: toFiniteNumber(record.HOLD_SHARES) ?? 0,
        holdMarketCap: toFiniteNumber(record.HOLD_MARKET_CAP) ?? 0,
      })
    }
    const points = [...byDate.values()].sort((a, b) => a.date - b.date)
    return { symbol: canonical, points }
  }
}
export type { Interval, Kline, Ticker }
