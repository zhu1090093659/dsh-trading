/**
 * OKX REST 客户端（dsh-trading okx 切片 R1-R3）。
 *
 * 独立于插件 glue：仅依赖 @dsh-trading/api 类型词汇 + node:crypto（HMAC-SHA256），
 * 无 cordis/dsh-tools 运行时依赖；fetch 可注入，便于单测与脚本直接消费。
 *
 * 数据面（docs/okx-integration.md §2/§3，2026-08-31 调研）：
 * - REST base = https://openapi.okx.com（生产与模拟盘同 host；demo 完全靠
 *   `x-simulated-trading: 1` 请求头区分，REST 层无独立域名）。
 * - 限频口径为「每 2 秒 N 次」，本客户端不主动限速，只做 10s 超时与结构化错误映射。
 *
 * 签名（调研 §1）：
 * - prehash = timestamp + METHOD + requestPath + body（字符串直连）；
 * - OK-ACCESS-SIGN = Base64(HMAC-SHA256(secret, prehash))；
 * - timestamp = UTC ISO 8601 毫秒精度（如 2020-12-08T09:08:57.715Z）；
 * - GET 的 query string 属于 requestPath（body 参与签名同理，JSON 原样）；
 * - 时差 >30s 即 50102：首个签名请求前先 GET /api/v5/public/time 对时并缓存偏移，
 *   收到 50102 时重对时并重试一次。
 *
 * @module @dsh-trading/connector-okx/rest
 */

import { createHmac } from 'node:crypto'
import type {
  Interval,
  Kline,
  Orderbook,
  OrderbookLevel,
  Ticker,
  TradeTick,
  TradingErrorCode,
} from '@dsh-trading/api'

/* ------------------------------------------------------------------ */
/* 错误载体（api 包词汇的运行时映射）                                      */
/* ------------------------------------------------------------------ */

/** api 包 TradingError 契约的运行时 Error 实现（connector-binance 同款）。 */
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
/* 签名原语（导出供已知向量单测）                                          */
/* ------------------------------------------------------------------ */

/**
 * 拼接签名 prehash：`timestamp + METHOD + requestPath + body`（调研 §1）。
 * GET 的 query 必须已并入 requestPath；无 body 时省略（传 undefined）。
 */
export function signaturePrehash(
  timestamp: string,
  method: 'GET' | 'POST',
  requestPath: string,
  body?: string,
): string {
  return timestamp + method + requestPath + (body ?? '')
}

/** OK-ACCESS-SIGN：Base64(HMAC-SHA256(secret, prehash))。 */
export function signPayload(secret: string, prehash: string): string {
  return createHmac('sha256', secret).update(prehash, 'utf8').digest('base64')
}

/** OK-ACCESS-TIMESTAMP：UTC ISO 8601 毫秒精度（Date.toISOString 即该形态）。 */
export function isoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/** OKX 三值凭证（BYOK：由插件层每次操作从 ctx.credentials 解析，绝不落盘/打日志）。 */
export interface OkxCredentials {
  readonly key: string
  readonly secret: string
  readonly passphrase: string
}

/** 签名请求的鉴权参数：三值凭证 + 是否打模拟盘。 */
export interface SignedAuth {
  readonly credentials: OkxCredentials
  /** true → 附加 `x-simulated-trading: 1`（模拟盘头级开关，调研 §2）。 */
  readonly simulated: boolean
}

/** 四头 + 模拟盘头的构造（导出供单测断言头部集合）。 */
export function buildAuthHeaders(
  auth: SignedAuth,
  timestamp: string,
  method: 'GET' | 'POST',
  requestPath: string,
  body?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'OK-ACCESS-KEY': auth.credentials.key,
    'OK-ACCESS-SIGN': signPayload(auth.credentials.secret, signaturePrehash(timestamp, method, requestPath, body)),
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': auth.credentials.passphrase,
  }
  if (auth.simulated) headers['x-simulated-trading'] = '1'
  return headers
}

/* ------------------------------------------------------------------ */
/* Interval → OKX bar 词汇映射（调研 §3.1）                                */
/* ------------------------------------------------------------------ */

/**
 * api Interval（Binance 词汇）→ OKX bar 词汇。
 *
 * **1d → 1Dutc（口径裁决，回应调研待验证 #3）**：OKX `1D` 按 UTC+8 零点开盘
 * （用户实证记忆：1D 日线边界对齐 UTC+8），而本仓 `Interval` 的 `1d` 语义继承自
 * Binance = UTC 零点。crypto 24/7 交易、UTC 是跨所通用口径，取 `1Dutc` 才能与
 * connector-binance 的日线对齐同一日界；`1D`（UTC+8）会导致同一标的跨连接器日 K
 * 错位 8 小时，故不取。6h/12h/3d/1w/1M 同理取 utc 变体。
 *
 * **8h 无映射**：OKX bar 词汇没有 8 小时档（1m..4H、6Hutc、12Hutc、1Dutc、2Dutc、
 * 3Dutc、1Wutc、1Mutc、3Mutc），8h 请求返回 TRADING_UNSUPPORTED_INTERVAL。
 */
export const BAR_MAP: Readonly<Record<string, string>> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '2h': '2H',
  '4h': '4H',
  '6h': '6Hutc',
  '12h': '12Hutc',
  '1d': '1Dutc',
  '3d': '3Dutc',
  '1w': '1Wutc',
  '1M': '1Mutc',
}

/** 支持的 interval 词汇（工具 enum 用；8h 刻意缺席，见 BAR_MAP 注释）。 */
export const OKX_INTERVAL_VOCABULARY: readonly string[] = Object.keys(BAR_MAP)

/** bar → 毫秒时长（closeTime 补算用；UTC 变体与本地变体时长相同）。 */
export function barDurationMs(bar: string): number {
  const m = /^(\d+)(m|H|D|W|M)(?:utc)?$/.exec(bar)
  if (!m) throw new TradingServiceError('TRADING_UNSUPPORTED_INTERVAL', `OKX: unknown bar ${bar}`)
  const amount = Number(m[1])
  switch (m[2]) {
    case 'm': return amount * 60_000
    case 'H': return amount * 3_600_000
    case 'D': return amount * 86_400_000
    case 'W': return amount * 7 * 86_400_000
    case 'M': return amount * 30 * 86_400_000 // 月 K 以 30 天近似（仅 closeTime 参照，非精确日历月）
  }
}

/** Interval → OKX bar；不支持（含 8h）抛 TRADING_UNSUPPORTED_INTERVAL。 */
export function toBar(interval: Interval): string {
  const bar = BAR_MAP[interval]
  if (bar === undefined) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_INTERVAL',
      `OKX klines: unsupported interval ${String(interval)} — OKX bar vocabulary has no 8h candle; supported: ${OKX_INTERVAL_VOCABULARY.join('/')}`,
    )
  }
  return bar
}

/* ------------------------------------------------------------------ */
/* 错误码映射（调研 §5 表）                                                */
/* ------------------------------------------------------------------ */

const DEFAULT_BASE_URL = 'https://openapi.okx.com'
const DEFAULT_TIMEOUT_MS = 10_000

export interface OkxRestOptions {
  /** 覆盖 API base（测试/反代用），末尾不带斜杠。 */
  readonly baseUrl?: string
  /** 单请求超时（ms），默认 10s。 */
  readonly timeoutMs?: number
  /** 注入 fetch 实现；缺省用全局 fetch（Node 22+ 内置）。 */
  readonly fetchImpl?: typeof fetch
  /** 禁用自动对时（离线单测）；缺省 true。 */
  readonly clockSync?: boolean
  /** 注入当前墙钟（ms）；缺省 Date.now（单测固定时间用）。 */
  readonly now?: () => number
  /** 预置服务器偏移（ms）；设置后跳过网络对时。 */
  readonly clockOffsetMs?: number
}

/**
 * OKX code → api 词汇已知映射（调研 §5）。51000/51400/51603 及其余 5xxxx 走
 * TRADING_EXCHANGE_ERROR 兜底；HTTP 层 5xx → TRADING_NETWORK、429 → RATE_LIMITED、
 * 401/403 → AUTH_FAILED（envelope code 命中本表时优先于 HTTP 状态，更具体）。
 */
const OKX_CODE_MAP: ReadonlyMap<string, TradingErrorCode> = new Map([
  ['50011', 'TRADING_RATE_LIMITED'],
  ['50013', 'TRADING_RATE_LIMITED'],
  ['50103', 'TRADING_CREDENTIALS_MISSING'],
  ['50104', 'TRADING_CREDENTIALS_MISSING'],
  ['50111', 'TRADING_CREDENTIALS_MISSING'],
  ['50105', 'TRADING_AUTH_FAILED'],
  ['50102', 'TRADING_AUTH_FAILED'],
  ['50112', 'TRADING_AUTH_FAILED'],
  ['50113', 'TRADING_AUTH_FAILED'],
  ['50114', 'TRADING_AUTH_FAILED'],
  ['50110', 'TRADING_AUTH_FAILED'],
  ['51008', 'TRADING_INSUFFICIENT_BALANCE'],
])

interface OkxEnvelope {
  readonly code?: unknown
  readonly msg?: unknown
  readonly data?: unknown
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** envelope/HTTP → TradingServiceError（msg/sCode 原文进 message，envelope 原样进 cause）。
 *  body 已由调用方解析时直接传入（Response 体只能读一次，重复 json() 会拿到 undefined）。 */
async function envelopeToError(res: Response, path: string, parsedBody?: unknown): Promise<TradingServiceError> {
  let body: unknown = parsedBody
  if (body === undefined) {
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
  }
  const env = (body ?? {}) as OkxEnvelope
  const code = str(env.code)
  const msg = str(env.msg) ?? ''
  const first = Array.isArray(env.data) ? env.data[0] as Record<string, unknown> | undefined : undefined
  const sCode = str(first?.sCode)
  const sMsg = str(first?.sMsg)

  let tradingCode: TradingErrorCode
  // code '1'/'2' 是「操作失败/部分成功」的泛型码：真实语义在 data[0].sCode，让位给 sCode。
  const meaningfulCode = code === '1' || code === '2'
    ? sCode !== undefined && sCode !== '0' ? sCode : undefined
    : code !== undefined && code !== '0' ? code : sCode !== undefined && sCode !== '0' ? sCode : undefined
  if (meaningfulCode !== undefined && OKX_CODE_MAP.has(meaningfulCode)) {
    tradingCode = OKX_CODE_MAP.get(meaningfulCode)!
  } else if (meaningfulCode !== undefined) {
    tradingCode = 'TRADING_EXCHANGE_ERROR'
  } else if (res.status === 429 || res.status === 418) {
    tradingCode = 'TRADING_RATE_LIMITED'
  } else if (res.status === 401 || res.status === 403) {
    tradingCode = 'TRADING_AUTH_FAILED'
  } else if (res.status >= 500) {
    tradingCode = 'TRADING_NETWORK'
  } else {
    tradingCode = 'TRADING_EXCHANGE_ERROR'
  }

  const detail = [
    res.status,
    code !== undefined && code !== '0' ? `code=${code}` : undefined,
    sCode !== undefined && sCode !== '0' ? `sCode=${sCode}` : undefined,
    msg || sMsg || res.statusText,
  ].filter((part) => part !== undefined && part !== '').join(' ')
  return new TradingServiceError(tradingCode, `OKX ${path}: ${detail}`, body)
}

/* ------------------------------------------------------------------ */
/* 端点词汇类型                                                            */
/* ------------------------------------------------------------------ */

/** OKX 资金费率快照（GET /api/v5/public/funding-rate，SWAP 专用）。 */
export interface OkxFundingRate {
  readonly instId: string
  readonly fundingRate: number
  readonly nextFundingRate?: number
  readonly fundingTime: number
  readonly nextFundingTime?: number
}

/** OKX 未平仓合约量快照（GET /api/v5/public/open-interest，SWAP 专用）。 */
export interface OkxOpenInterest {
  readonly instId: string
  /** 持仓量（张）。 */
  readonly oi: number
  /** 持仓量（base 币数；= 张数 × ctVal，OKX 直接回填）。 */
  readonly oiCcy?: number
  /** 持仓量价值（USD 计价）。 */
  readonly oiUsd?: number
  readonly ts: number
}

/** OKX 合约/币对规格（GET /api/v5/public/instruments；sz 单位纪律的依据，调研 §4）。 */
export interface OkxInstrument {
  readonly instId: string
  readonly instType: string
  /** 数量步进（SPOT=base 币；SWAP=张）。 */
  readonly lotSz: number
  /** 最小下单量（单位同 lotSz）。 */
  readonly minSz: number
  /** 价格步进。 */
  readonly tickSz: number
  /** 一张合约含多少币（仅 SWAP/FUTURES；SPOT 无此字段）。 */
  readonly ctVal?: number
  readonly ctValCcy?: string
  readonly settleCcy?: string
  readonly baseCcy?: string
  readonly quoteCcy?: string
}

/** POST /api/v5/trade/order 请求体词汇（R3 只做 market/limit；tdMode 现货=cash、永续=cross）。 */
export interface OkxPlaceOrderParams {
  readonly instId: string
  readonly tdMode: 'cash' | 'cross'
  readonly side: 'buy' | 'sell'
  readonly ordType: 'market' | 'limit'
  /** 字符串数量：SPOT=base 币数（market 单显式 tgtCcy=base_ccy）；SWAP=张（=coins/ctVal）。 */
  readonly sz: string
  readonly px?: string
  readonly tgtCcy?: 'base_ccy' | 'quote_ccy'
}

/** 客户端侧 sz 纪律校验结果：换算后的交易所数量字符串 + 提示（index.ts 组装请求体）。 */
export interface NormalizedSize {
  /** 发给交易所的 sz 字符串（SPOT=币数；SWAP=张）。 */
  readonly sz: string
  /** 现货市价单显式 tgtCcy=base_ccy（消除「buy 缺省按计价币金额」的坑，调研 §4）。 */
  readonly tgtCcy?: 'base_ccy'
}

/** 把 api 语义的 base 币数量换算成 OKX sz（本地精度校验：minSz/lotSz，省一次 51000 往返）。 */
export function normalizeSize(
  instId: string,
  instrument: OkxInstrument,
  quantityCoins: number,
): NormalizedSize {
  const isSwap = instrument.instType === 'SWAP'
  const amountInExchangeUnit = isSwap
    ? quantityCoins / (instrument.ctVal ?? Number.NaN)
    : quantityCoins
  if (!Number.isFinite(amountInExchangeUnit) || amountInExchangeUnit <= 0) {
    throw new TradingServiceError(
      'TRADING_EXCHANGE_ERROR',
      `OKX ${instId}: quantity ${quantityCoins} does not convert to a positive exchange amount`
        + (isSwap ? ` (ctVal=${String(instrument.ctVal)})` : ''),
    )
  }
  if (amountInExchangeUnit < instrument.minSz) {
    throw new TradingServiceError(
      'TRADING_EXCHANGE_ERROR',
      `OKX ${instId}: quantity ${quantityCoins} coins = ${amountInExchangeUnit} ${isSwap ? 'contracts' : 'base units'} is below minSz ${instrument.minSz}`,
    )
  }
  // 按 lotSz 步进向下取整（浮点噪声用 epsilon 消化）；向下保守，绝不上取放大敞口。
  const step = instrument.lotSz
  const units = Math.floor(amountInExchangeUnit / step + 1e-9) * step
  if (units <= 0) {
    throw new TradingServiceError(
      'TRADING_EXCHANGE_ERROR',
      `OKX ${instId}: quantity ${quantityCoins} coins rounds down to 0 at lotSz ${step}`,
    )
  }
  const sz = trimNumber(units)
  return isSwap ? { sz } : { sz, tgtCcy: 'base_ccy' }
}

/** 输出无尾随浮点噪声的数量字符串（最多 12 位有效小数）。 */
function trimNumber(n: number): string {
  const fixed = n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
  return fixed === '' ? '0' : fixed
}

/* ------------------------------------------------------------------ */
/* 客户端                                                                  */
/* ------------------------------------------------------------------ */

export class OkxRestClient {
  // TS 编译期 private（cordis 跨 realm 代理下 # 私有字段按类身份炸，replication 坑清单）。
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly clockSyncEnabled: boolean
  private readonly now: () => number
  /** 服务器偏移缓存（server - local，ms）；null = 未对时。 */
  private clockOffsetMs: number | null

  constructor(options: OkxRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // 缺省经 globalThis 取 fetch：调用时解析，便于 vi.stubGlobal 等全局替换也生效。
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.clockSyncEnabled = options.clockSync ?? true
    this.now = options.now ?? (() => Date.now())
    this.clockOffsetMs = options.clockOffsetMs ?? null
  }

  /** 当前对时后的墙钟（ms）。clockOffsetMs 预置或已缓存时直接用；否则按需对时。 */
  private async timestampMs(): Promise<number> {
    if (this.clockOffsetMs !== null) return this.now() + this.clockOffsetMs
    if (!this.clockSyncEnabled) return this.now()
    const rows = await this.request('/api/v5/public/time')
    const serverTs = num((rows[0] as Record<string, unknown> | undefined)?.ts)
    this.clockOffsetMs = serverTs !== undefined ? serverTs - this.now() : 0
    return this.now() + this.clockOffsetMs
  }

  /** 使缓存偏移失效（50102 重试路径）。 */
  invalidateClock(): void {
    this.clockOffsetMs = null
  }

  /**
   * 统一请求：query 拼 URL 与签名 requestPath；签名头经 buildAuthHeaders；
   * envelope code!=='0'（含 '1' 失败 / '2' 部分成功——本客户端只发单条操作）映射为
   * 结构化错误；50102（时差）重对时重试一次。
   */
  private async request(path: string, options: {
    readonly method?: 'GET' | 'POST'
    readonly query?: Record<string, string>
    readonly body?: string
    readonly auth?: SignedAuth
  } = {}, allowRetry = true): Promise<unknown[]> {
    const method = options.method ?? 'GET'
    const query = options.query ? new URLSearchParams(options.query).toString() : ''
    const requestPath = query ? `${path}?${query}` : path
    const target = `${this.baseUrl}${requestPath}`

    const headers: Record<string, string> = {}
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.auth !== undefined) {
      const timestamp = isoTimestamp(await this.timestampMs())
      Object.assign(headers, buildAuthHeaders(options.auth, timestamp, method, requestPath, options.body))
    }

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException(`request timed out after ${this.timeoutMs}ms`, 'TimeoutError')),
      this.timeoutMs,
    )
    let res: Response
    try {
      res = await this.fetchImpl(target, {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        signal: controller.signal,
      })
    } catch (cause) {
      const timedOut = controller.signal.aborted
      throw new TradingServiceError(
        'TRADING_NETWORK',
        timedOut ? `OKX ${path}: request timed out after ${this.timeoutMs}ms` : `OKX ${path}: network error`,
        cause,
      )
    } finally {
      clearTimeout(timer)
    }

    try {
      return await this.processEnvelope(res, path)
    } catch (error) {
      // 50102（timestamp expired，可能出现在 HTTP 401 envelope 或 sCode）：重对时重试
      // 一次（调研 §5——50102 的标准恢复路径）。
      if (allowRetry && options.auth !== undefined
        && error instanceof TradingServiceError && error.code === 'TRADING_AUTH_FAILED'
        && /\b50102\b/.test(error.message)) {
        this.invalidateClock()
        return this.request(path, options, false)
      }
      throw error
    }
  }

  /** envelope/HTTP 状态处理：code==='0' → data；单行 trade 端点的 sCode 非 0 → 失败。 */
  private async processEnvelope(res: Response, path: string): Promise<unknown[]> {
    if (!res.ok) throw await envelopeToError(res, path)
    let parsed: unknown
    try {
      parsed = await res.json()
    } catch (cause) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX ${path}: invalid JSON response`, cause)
    }
    const env = parsed as OkxEnvelope
    if (str(env.code) !== '0' || !Array.isArray(env.data)) {
      throw await envelopeToError(res, path, parsed)
    }
    const data = env.data
    // 批量形态端点（trade/order 等）单条操作也带 sCode：非 0 即失败。
    const first = data[0] as Record<string, unknown> | undefined
    const sCode = str(first?.sCode)
    if (sCode !== undefined && sCode !== '0') {
      throw await envelopeToError(res, path, parsed)
    }
    return data
  }

  /* -- 公共端点（无凭证；x-simulated-trading 也不需要） -------------------- */

  /** 最新行情：GET /api/v5/market/ticker。 */
  async getTicker(instId: string): Promise<Ticker> {
    const id = normalizeOkxSymbol(instId)
    const rows = await this.request('/api/v5/market/ticker', { query: { instId: id } })
    const d = rows[0] as Record<string, unknown> | undefined
    const price = num(d?.last)
    if (price === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX ticker for ${id}: missing/invalid last price`)
    }
    // 24h 量：SPOT 的 vol24h 即 base 币量；SWAP 的 vol24h 是张数，base 币量在 volCcy24h。
    const isSwap = id.endsWith('-SWAP')
    const volume = isSwap ? (num(d?.volCcy24h) ?? num(d?.vol24h)) : num(d?.vol24h)
    const prevClose = num(d?.open24h) ?? num(d?.sodUtc0)
    const changePercent = price !== undefined && prevClose !== undefined && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : undefined
    return {
      // 输出一律规范形（docs/symbol-vocabulary.md）：下游看到的是 BTCUSDT 而非 BTC-USDT。
      symbol: toCanonicalOkxSymbol(str(d?.instId) ?? id),
      price,
      timestamp: num(d?.ts) ?? Date.now(),
      ...(num(d?.bidPx) !== undefined ? { bid: num(d?.bidPx) } : {}),
      ...(num(d?.askPx) !== undefined ? { ask: num(d?.askPx) } : {}),
      ...(volume !== undefined ? { volume } : {}),
      ...(prevClose !== undefined ? { prevClose } : {}),
      ...(changePercent !== undefined ? { changePercent } : {}),
    }
  }

  /** K 线：GET /api/v5/market/candles（单请求上限 300，超出走 after 游标翻页；响应新→旧，翻转为旧→新）。 */
  async getKlines(instId: string, interval: Interval, limit = 100): Promise<Kline[]> {
    const id = normalizeOkxSymbol(instId)
    const bar = toBar(interval)
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX klines: limit must be an integer within 1..1000, got ${limit}`)
    }
    // 单请求上限 300；limit 更大时按 after 游标向前翻页补足（每页 min(剩余,300)
    // 根，游标 = 已收最旧一根的 openTime，OKX 返回严格早于该 ts 的记录），直到
    // 取满、上游返回不足一页（窗口耗尽）或空页。candles 端点可回看深度随 bar
    // 档位而定（日线约 1440 根），近三年日 K（~750 根）在该窗口内。
    const collected: Kline[] = []
    const seenOpenTimes = new Set<number>()
    let cursor: number | undefined
    while (collected.length < limit) {
      const pageSize = Math.min(limit - collected.length, 300)
      const query: Record<string, string> = { instId: id, bar, limit: String(pageSize) }
      if (cursor !== undefined) query.after = String(cursor)
      const rows = await this.request('/api/v5/market/candles', { query })
      if (!Array.isArray(rows)) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX klines for ${id}: unexpected response shape`)
      }
      if (rows.length === 0) break
      // 行结构 [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]；confirm='0' 为未收盘 bar。
      // 响应新→旧；跨页去重兜底（游标翻页本应严格更旧）。
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 6) {
          throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX klines: malformed row for ${id}`)
        }
        const openTime = num(row[0])
        const open = num(row[1])
        const high = num(row[2])
        const low = num(row[3])
        const close = num(row[4])
        const volume = num(row[5])
        if (openTime === undefined || open === undefined || high === undefined || low === undefined
          || close === undefined || volume === undefined) {
          throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX klines: malformed row values for ${id}`)
        }
        if (seenOpenTimes.has(openTime)) continue
        seenOpenTimes.add(openTime)
        collected.push({ openTime, open, high, low, close, volume, closeTime: openTime + barDurationMs(bar) - 1 })
      }
      if (rows.length < pageSize) break
      const oldest = num((rows[rows.length - 1] as unknown[])[0])
      if (oldest === undefined) break
      cursor = oldest
    }
    return collected.reverse()
  }

  /** 资金费率：GET /api/v5/public/funding-rate（仅 SWAP；10 次/2s）。 */
  async getFundingRate(instId: string): Promise<OkxFundingRate> {
    const id = normalizeOkxSymbol(instId)
    if (!id.endsWith('-SWAP')) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `OKX funding rate requires a perpetual swap instId (e.g. BTC-USDT-SWAP), got ${id}`,
      )
    }
    const rows = await this.request('/api/v5/public/funding-rate', { query: { instId: id } })
    const d = rows[0] as Record<string, unknown> | undefined
    const fundingRate = num(d?.fundingRate)
    const fundingTime = num(d?.fundingTime)
    if (fundingRate === undefined || fundingTime === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX funding rate for ${id}: missing/invalid fields`)
    }
    const nextFundingRate = num(d?.nextFundingRate)
    const nextFundingTime = num(d?.nextFundingTime)
    return {
      instId: str(d?.instId) ?? id,
      fundingRate,
      fundingTime,
      ...(nextFundingRate !== undefined ? { nextFundingRate } : {}),
      ...(nextFundingTime !== undefined ? { nextFundingTime } : {}),
    }
  }

  /* -- 盘口与逐笔（issue #39）---------------------------------------------- */

  /** books 档位行 [price, size, liqOrders, numOrders] → OrderbookLevel。 */
  #parseBookRow(row: unknown): OrderbookLevel | undefined {
    if (!Array.isArray(row) || row.length < 2) return undefined
    const price = num(row[0])
    const amount = num(row[1])
    if (price === undefined || amount === undefined || price <= 0 || amount <= 0) return undefined
    return { price, amount }
  }

  /** 盘口快照：GET /api/v5/market/books（sz=20 档；bids 降序 / asks 升序，OKX 原生序）。 */
  async getOrderbook(instId: string): Promise<Orderbook> {
    const id = normalizeOkxSymbol(instId)
    const rows = await this.request('/api/v5/market/books', { query: { instId: id, sz: '20' } })
    const d = rows[0] as Record<string, unknown> | undefined
    if (d === undefined || !Array.isArray(d.bids) || !Array.isArray(d.asks)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX books for ${id}: unexpected response shape`)
    }
    const bids = (d.bids as unknown[]).map(row => this.#parseBookRow(row)).filter((l): l is OrderbookLevel => l !== undefined)
    const asks = (d.asks as unknown[]).map(row => this.#parseBookRow(row)).filter((l): l is OrderbookLevel => l !== undefined)
    const ts = num(d.ts) ?? Date.now()
    return { symbol: toCanonicalOkxSymbol(id), bids, asks, timestamp: ts }
  }

  /** trades 行 → TradeTick（side 即 taker 方向；OKX 响应新→旧，反转为升序）。 */
  #parseTradeRow(row: unknown, symbol: string): TradeTick {
    const d = row as Record<string, unknown>
    const price = num(d.px)
    const amount = num(d.sz)
    if (price === undefined || amount === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX trades for ${symbol}: malformed trade row`)
    }
    const side = d.side === 'buy' || d.side === 'sell' ? d.side : 'unknown'
    return {
      id: str(d.tradeId) ?? '',
      symbol,
      price,
      amount,
      side,
      timestamp: num(d.ts) ?? Date.now(),
    }
  }

  /** 最近逐笔成交：GET /api/v5/market/trades（响应新→旧 → 反转为时间升序）。 */
  async getRecentTrades(instId: string, limit = 50): Promise<TradeTick[]> {
    const id = normalizeOkxSymbol(instId)
    const capped = Math.max(1, Math.min(Math.floor(limit) || 50, 100))
    const rows = await this.request('/api/v5/market/trades', { query: { instId: id, limit: String(capped) } })
    const symbol = toCanonicalOkxSymbol(id)
    return rows.map(row => this.#parseTradeRow(row, symbol)).reverse()
  }

  /** 未平仓合约量：GET /api/v5/public/open-interest（仅 SWAP；oi=张、oiCcy=币、oiUsd=USD）。 */  async getOpenInterest(instId: string): Promise<OkxOpenInterest> {
    const id = normalizeOkxSymbol(instId)
    if (!id.endsWith('-SWAP')) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `OKX open interest requires a perpetual swap instId (e.g. BTC-USDT-SWAP), got ${id}`,
      )
    }
    const rows = await this.request('/api/v5/public/open-interest', { query: { instType: 'SWAP', instId: id } })
    const d = rows[0] as Record<string, unknown> | undefined
    const oi = num(d?.oi)
    if (oi === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX open interest for ${id}: missing/invalid oi`)
    }
    const oiCcy = num(d?.oiCcy)
    const oiUsd = num(d?.oiUsd)
    const ts = num(d?.ts) ?? Date.now()
    return {
      instId: str(d?.instId) ?? id,
      oi,
      ...(oiCcy !== undefined ? { oiCcy } : {}),
      ...(oiUsd !== undefined ? { oiUsd } : {}),
      ts,
    }
  }

  /**
   * 多空账户人数比：GET /api/v5/rubik/stat/contracts/long-short-account-ratio（ccy=base 资产，period=1H）。
   * 响应是时间序列行 `[ts, ratio]`（字符串数值，新→旧；2026-09-02 真实网络实证，
   * spikes/impl-crypto-derivatives），取最新一行。
   */
  async getLongShortAccountRatio(ccy: string): Promise<{ ccy: string; ratio: number; ts?: number }> {
    const rows = await this.request('/api/v5/rubik/stat/contracts/long-short-account-ratio', {
      query: { ccy, period: '1H' },
    })
    const row = rows[0] as unknown[] | undefined
    const ratio = Array.isArray(row) ? num(row[1]) : undefined
    if (ratio === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX long/short account ratio for ${ccy}: missing/invalid ratio`)
    }
    const ts = Array.isArray(row) ? num(row[0]) : undefined
    return {
      ccy,
      ratio,
      ...(ts !== undefined ? { ts } : {}),
    }
  }

  /**
   * 合约主动买卖量：GET /api/v5/rubik/stat/taker-volume（ccy=base 资产，instType=CONTRACTS）。
   * 响应是时间序列行 `[ts, buyVol, sellVol]`（字符串数值，新→旧；2026-09-02 真实网络
   * 实证，spikes/impl-crypto-derivatives），取最新一行。
   */
  async getContractTakerVolume(ccy: string): Promise<{ ccy: string; buyVol: number; sellVol: number }> {
    const rows = await this.request('/api/v5/rubik/stat/taker-volume', {
      query: { ccy, instType: 'CONTRACTS' },
    })
    const row = rows[0] as unknown[] | undefined
    const buyVol = Array.isArray(row) ? num(row[1]) : undefined
    const sellVol = Array.isArray(row) ? num(row[2]) : undefined
    if (buyVol === undefined || sellVol === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX taker volume for ${ccy}: missing/invalid buyVol/sellVol`)
    }
    return { ccy, buyVol, sellVol }
  }

  /** 合约/币对规格：GET /api/v5/public/instruments（sz 纪律的 ctVal/lotSz/minSz 来源）。 */
  async getInstruments(instType: 'SPOT' | 'SWAP', instId?: string): Promise<OkxInstrument[]> {
    const rows = await this.request('/api/v5/public/instruments', {
      query: instId !== undefined ? { instType, instId } : { instType },
    })
    return rows.map((row) => {
      const d = row as Record<string, unknown>
      const id = str(d.instId)
      const lotSz = num(d.lotSz)
      const minSz = num(d.minSz)
      const tickSz = num(d.tickSz)
      if (id === undefined || lotSz === undefined || minSz === undefined || tickSz === undefined) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX instruments: malformed row`)
      }
      const ctVal = num(d.ctVal)
      return {
        instId: id,
        instType: str(d.instType) ?? instType,
        lotSz,
        minSz,
        tickSz,
        ...(ctVal !== undefined ? { ctVal } : {}),
        ...(str(d.ctValCcy) !== undefined ? { ctValCcy: str(d.ctValCcy) } : {}),
        ...(str(d.settleCcy) !== undefined ? { settleCcy: str(d.settleCcy) } : {}),
        ...(str(d.baseCcy) !== undefined ? { baseCcy: str(d.baseCcy) } : {}),
        ...(str(d.quoteCcy) !== undefined ? { quoteCcy: str(d.quoteCcy) } : {}),
      }
    })
  }

  /**
   * 全部可交易现货标的名册（GET /api/v5/public/instruments?instType=SPOT，Issue #15）。
   * 输出 symbol 归一化为市场规范形（BTC-USDT → BTCUSDT），name 为 baseCcy/quoteCcy。
   */
  async listInstruments(): Promise<Array<{ symbol: string; name?: string }>> {
    const instruments = await this.getInstruments('SPOT')
    return instruments.map((inst) => {
      const canonical = toCanonicalOkxSymbol(inst.instId)
      const name = inst.baseCcy && inst.quoteCcy ? `${inst.baseCcy}/${inst.quoteCcy}` : undefined
      return { symbol: canonical, ...(name ? { name } : {}) }
    })
  }

  /* -- 签名端点（四头 + demo 头；凭证由调用方每次操作解析） ------------------ */

  /** 只读余额：GET /api/v5/account/balance（ccy 可选，逗号分隔 ≤20）。 */
  async getBalance(auth: SignedAuth, ccy?: string): Promise<unknown[]> {
    return this.request('/api/v5/account/balance', {
      query: ccy !== undefined ? { ccy } : undefined,
      auth,
    })
  }

  /** 只读持仓：GET /api/v5/account/positions（instId 可选过滤）。 */
  async getPositions(auth: SignedAuth, instId?: string): Promise<unknown[]> {
    return this.request('/api/v5/account/positions', {
      query: instId !== undefined ? { instId } : undefined,
      auth,
    })
  }

  /** 下单：POST /api/v5/trade/order（60 次/2s）。 */
  async placeOrder(params: OkxPlaceOrderParams, auth: SignedAuth): Promise<unknown[]> {
    return this.request('/api/v5/trade/order', {
      method: 'POST',
      body: JSON.stringify(params),
      auth,
    })
  }

  /** 撤单：POST /api/v5/trade/cancel-order（ordId 优先于 clOrdId，本切片只支持 ordId）。 */
  async cancelOrder(instId: string, ordId: string, auth: SignedAuth): Promise<unknown[]> {
    return this.request('/api/v5/trade/cancel-order', {
      method: 'POST',
      body: JSON.stringify({ instId, ordId }),
      auth,
    })
  }

  /** 查单：GET /api/v5/trade/order（query 属于签名 requestPath）。 */
  async getOrder(instId: string, ordId: string, auth: SignedAuth): Promise<unknown[]> {
    return this.request('/api/v5/trade/order', {
      query: { instId, ordId },
      auth,
    })
  }

  /** 当前挂单：GET /api/v5/trade/orders-pending（instId 可选过滤；issue #40 交易台）。 */
  async listPendingOrders(instId: string | undefined, auth: SignedAuth): Promise<unknown[]> {
    return this.request('/api/v5/trade/orders-pending', {
      query: instId !== undefined ? { instId } : undefined,
      auth,
    })
  }

  /** 最近成交明细：GET /api/v5/trade/fills-history（instId/limit 可选；issue #40 交易台）。 */
  async listFillsHistory(instId: string | undefined, limit: number | undefined, auth: SignedAuth): Promise<unknown[]> {
    const query: Record<string, string> = {}
    if (instId !== undefined) query.instId = instId
    if (limit !== undefined) query.limit = String(limit)
    return this.request('/api/v5/trade/fills-history', {
      query: Object.keys(query).length > 0 ? query : undefined,
      auth,
    })
  }
}

/** instId 校验（R3 词汇：SPOT `BASE-QUOTE` 与 SWAP `BASE-QUOTE-SWAP`，OKX 原生连字符）。 */
const INST_ID_PATTERN = /^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}(-SWAP)?$/

/* ------------------------------------------------------------------ */
/* 符号互译（docs/symbol-vocabulary.md，2026-08-31 规范词汇）              */
/* ------------------------------------------------------------------ */

/**
 * 规范形（crypto canonical）：BASEQUOTE 大写无分隔（BTCUSDT），衍生品预留
 * BASEQUOTE-SWAP。OKX 原生形：BTC-USDT / BTC-USDT-SWAP。
 */
/**
 * 已知 quote 货币后缀表（规范形拆 base/quote 的依据；最长匹配优先）。
 * 表是连接器私有实现——新 quote 货币上线在此增补（规范只管词汇形态）。
 */
const KNOWN_QUOTES = ['USDT', 'USDC', 'USD', 'EUR', 'BTC', 'ETH', 'OKB'] as const

/**
 * 输入归一 → OKX 原生 instId。接受规范形（BTCUSDT / BTCUSDT-SWAP）与原生形
 *（BTC-USDT / BTC-USDT-SWAP）；都解析不出才报 TRADING_UNSUPPORTED_SYMBOL。
 */
export function normalizeOkxSymbol(input: string): string {
  const id = typeof input === 'string' ? input.trim().toUpperCase() : ''
  // 按 dash 数消歧：规范 SWAP（BTCUSDT-SWAP，单横杠）与原生现货（BTC-USDT，单横杠）
  // 同形——第二段恰为 'SWAP' 时按规范 SWAP 解（不存在 quote 货币叫 SWAP）；原生 SWAP
  //（BTC-USDT-SWAP）双横杠无歧义。
  const parts = id.split('-')
  const splitCanonicalPair = (pair: string, swapSuffix: string): string | undefined => {
    if (!/^[A-Z0-9]{2,24}$/.test(pair)) return undefined
    for (const quote of KNOWN_QUOTES) {
      if (pair.length > quote.length && pair.endsWith(quote)) {
        return pair.slice(0, -quote.length) + '-' + quote + swapSuffix
      }
    }
    return undefined
  }
  if (parts.length === 3) {
    if (INST_ID_PATTERN.test(id)) return id // 原生 SWAP
  } else if (parts.length === 2) {
    if (parts[1] === 'SWAP') {
      const translated = splitCanonicalPair(parts[0] ?? '', '-SWAP') // 规范 SWAP
      if (translated !== undefined) return translated
    } else if (INST_ID_PATTERN.test(id)) {
      return id // 原生现货
    }
  } else if (parts.length === 1) {
    const translated = splitCanonicalPair(id, '') // 规范现货
    if (translated !== undefined) return translated
  }
  throw new TradingServiceError(
    'TRADING_UNSUPPORTED_SYMBOL',
    'OKX: cannot parse symbol ' + JSON.stringify(input)
      + ' — use market-canonical vocabulary (BTCUSDT / BTCUSDT-SWAP) or OKX native (BTC-USDT / BTC-USDT-SWAP)',
  )
}

/**
 * 输出归一 → 规范形（下游永远看到市场规范词汇）。原生 BTC-USDT → BTCUSDT；
 * BTC-USDT-SWAP → BTCUSDT-SWAP；已是规范形则原样返回。
 */
export function toCanonicalOkxSymbol(symbol: string): string {
  const id = typeof symbol === 'string' ? symbol.trim().toUpperCase() : ''
  if (!id.includes('-')) return id
  const parts = id.split('-')
  if (parts[parts.length - 1] === 'SWAP') return parts.slice(0, -1).join('') + '-SWAP'
  return parts.join('')
}

/**
 * 衍生品端点输入归一：现货与合约输入一律升到永续 SWAP instId——
 * BTCUSDT / BTC-USDT / BTCUSDT-SWAP / BTC-USDT-SWAP → BTC-USDT-SWAP。
 * （GUI 选中的现货标的也要能看到对应合约的衍生品指标，issue #38。）
 */
export function toOkxSwapInstId(input: string): string {
  const id = normalizeOkxSymbol(input)
  return id.endsWith('-SWAP') ? id : `${id}-SWAP`
}
