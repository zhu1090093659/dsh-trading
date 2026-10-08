/**
 * Binance 公共 REST 客户端（dsh-trading crypto 切片）。
 *
 * 独立于插件 glue：仅依赖 @dshtrading/api 的类型词汇，无 cordis/dsh-tools 运行时依赖，
 * 便于单测与脚本直接消费（fetch 可注入）。数据面：api.binance.com 公共 REST（/api/v3）
 * 与 USDT-M 合约 fapi.binance.com（/fapi/v1），全局 fetch（Node 22+ 内置），
 * AbortController 10s 超时，零凭证（铁律 #3：公共行情无需 key）。
 *
 * 形态分流（2026-10-08）：名册 = 现货 ∪ 永续（`BTCUSDT` 与 `BTCUSDT-SWAP` 成对）；
 * 行情方法按规范后缀选 base（`resolveBinanceInstrument`），不新增 form 形参。
 *
 * @module @dshtrading/connector-binance/rest
 */

import type {
  DerivativesPoint,
  InstrumentAssetClass,
  InstrumentContract,
  InstrumentForm,
  InstrumentRef,
  Interval,
  Kline,
  Orderbook,
  OrderbookLevel,
  Ticker,
  TradeTick,
  TradingErrorCode,
} from '@dshtrading/api'
import { SWAP_SYMBOL_SUFFIX, instrumentFormOf } from '@dshtrading/api'

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
const DEFAULT_FAPI_BASE_URL = 'https://fapi.binance.com'
const DEFAULT_TIMEOUT_MS = 10_000

export interface BinanceRestOptions {
  /** 覆盖 API base（测试/反代用），末尾不带斜杠。 */
  readonly baseUrl?: string
  /** 覆盖 USDT-M 合约（fapi）base（测试/反代用），末尾不带斜杠。 */
  readonly fapiBaseUrl?: string
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

/**
 * 衍生品输入归一（issue #38，与 kit-crypto/derivatives 同词汇）：规范现货、规范 SWAP、
 * OKX 原生 SWAP 形一律归一到 fapi 词汇——BTCUSDT / BTCUSDT-SWAP / BTC-USDT-SWAP → BTCUSDT。
 */
export function normalizeBinanceFuturesSymbol(raw: string): string {
  const clean = requireSymbol(raw).replace(/[-_]/g, '')
  return clean.endsWith('SWAP') ? clean.slice(0, -4) : clean
}

/**
 * 输入符号 → 形态 + 交易所词汇（2026-10-08 加密永续落地）。
 *
 * Binance 现货与永续在交易所侧**同形**（都叫 `BTCUSDT`），形态只能由规范后缀
 * `-SWAP` 裁决——单一实现是 @dshtrading/api 的 `instrumentFormOf`，这里不另写
 * 一份 endsWith。永续剥掉后缀后复用既有衍生品归一（同时容忍 OKX 原生形
 * `BTC-USDT-SWAP`）；现货保持原样交给交易所判存在性（未知符号仍报 -1121）。
 */
export function resolveBinanceInstrument(symbol: string): { form: InstrumentForm; venueSymbol: string } {
  const upper = requireSymbol(symbol)
  const form = instrumentFormOf(upper)
  if (form === 'spot') return { form, venueSymbol: upper }
  const venueSymbol = normalizeBinanceFuturesSymbol(upper)
  if (venueSymbol === '') {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Binance: ${JSON.stringify(symbol)} carries the ${SWAP_SYMBOL_SUFFIX} suffix but has no base symbol`,
    )
  }
  return { form, venueSymbol }
}

/** Binance 返回数值均为字符串，宽松转 number（非有限值返回 undefined）。 */
function num(value: unknown): number | undefined {
  // 空串不是 0（Number('')===0 的 JS 坑）：上游「未发布」字段（如 OKX nextFundingRate）
  // 用空串表达，必须缺省而非编造 0（issue #54 评审 M1，spikes EVIDENCE 实证）。
  if (value === '') return undefined
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

/** depth 档位行 [price, quantity] → OrderbookLevel（字符串数值，宽容解析）。 */
function parseDepthLevel(row: unknown): OrderbookLevel | undefined {
  if (!Array.isArray(row) || row.length < 2) return undefined
  const price = num(row[0])
  const amount = num(row[1])
  if (price === undefined || amount === undefined || price <= 0 || amount <= 0) return undefined
  return { price, amount }
}

/** depth 响应（bids 降序 / asks 升序，Binance 原生序）→ Orderbook。 */
function parseDepthBody(body: unknown, symbol: string): Orderbook {
  const d = body as { bids?: unknown; asks?: unknown }
  if (!Array.isArray(d?.bids) || !Array.isArray(d?.asks)) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance depth for ${symbol}: unexpected response shape`)
  }
  const bids = d.bids.map(parseDepthLevel).filter((l): l is OrderbookLevel => l !== undefined)
  const asks = d.asks.map(parseDepthLevel).filter((l): l is OrderbookLevel => l !== undefined)
  return { symbol, bids, asks, timestamp: Date.now() }
}

/** 逐笔成交行（/api/v3/trades）→ TradeTick（isBuyerMaker=true → taker 是卖方）。 */
function parseTradeRow(row: unknown, symbol: string): TradeTick {
  const d = row as Record<string, unknown>
  const price = num(d.price)
  const amount = num(d.qty)
  if (price === undefined || amount === undefined) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance trades for ${symbol}: malformed trade row`)
  }
  return {
    id: String(d.id ?? ''),
    symbol,
    price,
    amount,
    side: d.isBuyerMaker === true ? 'sell' : d.isBuyerMaker === false ? 'buy' : 'unknown',
    timestamp: num(d.time) ?? Date.now(),
  }
}

/* ------------------------------------------------------------------ */
/* 名册元数据（2026-10-08：现货 ∪ USDT-M 永续，形态/资产类别/合约规格透传）    */
/* ------------------------------------------------------------------ */

/**
 * Binance 合约 underlying 元数据 → 资产类别标签。
 *
 * 只登记 Binance 公开字段的**实测取值**；未登记一律 undefined（留空），禁止按符号猜
 * （硬不变量 #2：TradFi 归属只信交易所元数据）。
 *
 * 2026-10-08 可达环境实测取值（924 行 USDT-M exchangeInfo，见
 * spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md）：
 * COIN 704 / EQUITY 179 / HK_EQUITY 15 / COMMODITY 8 / KR_EQUITY 8 / PREMARKET 4 /
 * INDEX 3 / CN_EQUITY 2 / FX 1。
 * - PREMARKET 是 Pre-IPO 股票合约（OPENAI/ANTHROPIC/MOONSHOT/OURA，underlyingSubType
 *   ["Pre-IPO","TradFi"]）⇒ 归 equity；枚举里没有 premarket 成员，投影由字面量裁决而非符号。
 * - FX（USDBRLUSDT）**故意不登记**：枚举没有外汇成员，硬塞进 equity/commodity 就是错标，
 *   按「未登记即留空」兜底（漏标而非错标）。要不要加 FX 成员属契约层决定，不在本连接器内定。
 */
const BINANCE_UNDERLYING_ASSET_CLASS: Readonly<Record<string, InstrumentAssetClass>> = {
  COIN: 'crypto',
  CRYPTO: 'crypto',
  STOCK: 'equity',
  EQUITY: 'equity',
  HK_EQUITY: 'equity',
  KR_EQUITY: 'equity',
  CN_EQUITY: 'equity',
  PREMARKET: 'equity',
  INDEX: 'index',
  COMMODITY: 'commodity',
}

/**
 * USDT-M 名册里的永续字面量：加密永续 `PERPETUAL`、TradFi 永续 `TRADIFI_PERPETUAL`
 * （2026-10-08 实测 703 / 217）。只按 `PERPETUAL` 过滤会把全部 TradFi 永续整批漏掉。
 */
const BINANCE_PERPETUAL_CONTRACT_TYPES: ReadonlySet<string> = new Set(['PERPETUAL', 'TRADIFI_PERPETUAL'])

/** underlyingType（含 underlyingSubType 逐项兜底）→ 资产类别；未登记/缺失 = undefined。 */
export function binanceAssetClassOf(underlyingType: unknown, underlyingSubType: unknown): InstrumentAssetClass | undefined {
  const candidates: unknown[] = [underlyingType]
  if (Array.isArray(underlyingSubType)) candidates.push(...underlyingSubType)
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const mapped = BINANCE_UNDERLYING_ASSET_CLASS[candidate.trim().toUpperCase()]
    if (mapped !== undefined) return mapped
  }
  return undefined
}

/** exchangeInfo filter 行（PRICE_FILTER.tickSize / LOT_SIZE.stepSize）。 */
interface BinanceFilterRow {
  readonly filterType?: unknown
  readonly tickSize?: unknown
  readonly stepSize?: unknown
}

/** USDT-M 合约规格 → InstrumentContract（交易所元数据原样透传；字段缺失即缺省）。 */
export function binanceContractOf(row: {
  readonly contractSize?: unknown
  readonly marginAsset?: unknown
  readonly filters?: unknown
}): InstrumentContract | undefined {
  const filters = Array.isArray(row.filters) ? row.filters as BinanceFilterRow[] : []
  const multiplier = num(row.contractSize)
  const tickSize = num(filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize)
  const lotSize = num(filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize)
  const settleCcy = typeof row.marginAsset === 'string' && row.marginAsset !== '' ? row.marginAsset : undefined
  if (multiplier === undefined && tickSize === undefined && lotSize === undefined && settleCcy === undefined) {
    return undefined
  }
  return {
    ...(multiplier !== undefined ? { multiplier } : {}),
    ...(tickSize !== undefined ? { tickSize } : {}),
    ...(lotSize !== undefined ? { lotSize } : {}),
    ...(settleCcy !== undefined ? { settleCcy } : {}),
  }
}

export class BinanceRestClient {
  readonly #baseUrl: string
  readonly #fapiBaseUrl: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch

  constructor(options: BinanceRestOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.#fapiBaseUrl = options.fapiBaseUrl ?? DEFAULT_FAPI_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // 缺省经 globalThis 取 fetch：调用时解析，便于 vi.stubGlobal 等全局替换也生效。
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async #request(path: string, params: Record<string, string>, base: string = this.#baseUrl): Promise<unknown> {
    const query = new URLSearchParams(params).toString()
    const target = query ? `${base}${path}?${query}` : `${base}${path}`
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
   * 最新行情（2026-10-08 形态分流）：现货 /api/v3/ticker/24hr + bookTicker；
   * 永续（`-SWAP` 后缀）走 USDT-M /fapi/v1/ticker/24hr + bookTicker。
   * 两条路径各自报结构化错误——绝不用现货报价冒充合约价（降级纪律）。
   */
  async getTicker(symbol: string): Promise<Ticker> {
    const { form, venueSymbol } = resolveBinanceInstrument(symbol)
    const perp = form === 'perp'
    const prefix = perp ? '/fapi/v1/ticker' : '/api/v3/ticker'
    const base = perp ? this.#fapiBaseUrl : this.#baseUrl
    const [day, book] = await Promise.all([
      this.#request(`${prefix}/24hr`, { symbol: venueSymbol }, base),
      this.#request(`${prefix}/bookTicker`, { symbol: venueSymbol }, base),
    ])
    const d = day as Record<string, unknown>
    const b = book as Record<string, unknown>
    const price = num(d.lastPrice)
    if (price === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance ticker for ${venueSymbol}: missing/invalid lastPrice`)
    }
    const bid = num(b.bidPrice)
    const ask = num(b.askPrice)
    const volume = num(d.volume)
    const prevClose = num(d.prevClosePrice)
    const changePercent = num(d.priceChangePercent)
    const resolvedSymbol = typeof d.symbol === 'string' && d.symbol ? d.symbol : venueSymbol
    return {
      // 输出恒为规范形：合约价必须以 -SWAP 形回到下游（否则现货/合约在消费方同名）。
      symbol: perp ? `${resolvedSymbol}${SWAP_SYMBOL_SUFFIX}` : resolvedSymbol,
      price,
      timestamp: Date.now(),
      ...(bid !== undefined ? { bid } : {}),
      ...(ask !== undefined ? { ask } : {}),
      ...(volume !== undefined ? { volume } : {}),
      ...(prevClose !== undefined ? { prevClose } : {}),
      ...(changePercent !== undefined ? { changePercent } : {}),
    }
  }

  /** K 线（2026-10-08 形态分流）：现货 /api/v3/klines；永续 /fapi/v1/klines，行结构同形。 */
  async getKlines(symbol: string, interval: Interval, limit = 100): Promise<Kline[]> {
    const { form, venueSymbol } = resolveBinanceInstrument(symbol)
    const perp = form === 'perp'
    if (!isInterval(interval)) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_INTERVAL', `Binance klines: unsupported interval ${String(interval)}`)
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance klines: limit must be an integer within 1..1000, got ${limit}`)
    }
    const body = await this.#request(
      perp ? '/fapi/v1/klines' : '/api/v3/klines',
      { symbol: venueSymbol, interval, limit: String(limit) },
      perp ? this.#fapiBaseUrl : this.#baseUrl,
    )
    if (!Array.isArray(body)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance klines for ${venueSymbol}: unexpected response shape`)
    }
    return body.map((row) => parseKlineRow(row, venueSymbol))
  }

  /**
   * 全部可交易标的名册 = 现货 ∪ USDT-M 永续（2026-10-08 形态维度落地，Issue #15 扩展）。
   *
   * - 现货：GET /api/v3/exchangeInfo，`status=TRADING` → `BTCUSDT`（form=spot，
   *   assetClass=crypto：Binance 现货名册无 TradFi 条目）。
   * - 永续：GET /fapi/v1/exchangeInfo，`contractType` ∈ {PERPETUAL, TRADIFI_PERPETUAL}
   *   且 `status=TRADING` → `BTCUSDT-SWAP`（form=perp，与现货成对）；assetClass 取
   *   underlyingType/underlyingSubType（取不到留空），contract 取 contractSize/
   *   filters/marginAsset。TradFi 永续的字面量是 TRADIFI_PERPETUAL（实测 217 行），
   *   只认 PERPETUAL 会把股票/大宗/外汇合约整批漏掉。
   *
   * 两半都是名册契约的一部分：任一半失败即抛结构化错误，**不返回半份名册**
   * （静默半份会让检索排序与可用性判断失真，调用方按错误决定自己的兜底目录）。
   */
  async listInstruments(): Promise<InstrumentRef[]> {
    const [spotBody, futuresBody] = await Promise.all([
      this.#request('/api/v3/exchangeInfo', {}),
      this.#request('/fapi/v1/exchangeInfo', {}, this.#fapiBaseUrl),
    ])
    const spotSymbols = (spotBody as { symbols?: unknown }).symbols
    if (!Array.isArray(spotSymbols)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Binance exchangeInfo: invalid response shape')
    }
    const futuresSymbols = (futuresBody as { symbols?: unknown }).symbols
    if (!Array.isArray(futuresSymbols)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Binance futures exchangeInfo: invalid response shape')
    }

    const result: InstrumentRef[] = []
    for (const raw of spotSymbols) {
      const item = raw as { symbol?: unknown; status?: unknown; baseAsset?: unknown; quoteAsset?: unknown }
      if (item?.status !== 'TRADING' || typeof item.symbol !== 'string' || item.symbol === '') continue
      const name = typeof item.baseAsset === 'string' && item.baseAsset !== ''
        && typeof item.quoteAsset === 'string' && item.quoteAsset !== ''
        ? `${item.baseAsset}/${item.quoteAsset}`
        : undefined
      result.push({
        symbol: item.symbol,
        ...(name !== undefined ? { name } : {}),
        form: 'spot',
        assetClass: 'crypto',
      })
    }
    for (const raw of futuresSymbols) {
      const item = raw as {
        symbol?: unknown
        status?: unknown
        contractType?: unknown
        baseAsset?: unknown
        quoteAsset?: unknown
        underlyingType?: unknown
        underlyingSubType?: unknown
        marginAsset?: unknown
        contractSize?: unknown
        filters?: unknown
      }
      if (typeof item?.contractType !== 'string' || !BINANCE_PERPETUAL_CONTRACT_TYPES.has(item.contractType)
        || item.status !== 'TRADING'
        || typeof item.symbol !== 'string' || item.symbol === '') continue
      const name = typeof item.baseAsset === 'string' && item.baseAsset !== ''
        && typeof item.quoteAsset === 'string' && item.quoteAsset !== ''
        ? `${item.baseAsset}/${item.quoteAsset}`
        : undefined
      const assetClass = binanceAssetClassOf(item.underlyingType, item.underlyingSubType)
      const contract = binanceContractOf(item)
      result.push({
        symbol: `${item.symbol}${SWAP_SYMBOL_SUFFIX}`,
        ...(name !== undefined ? { name } : {}),
        form: 'perp',
        ...(assetClass !== undefined ? { assetClass } : {}),
        ...(contract !== undefined ? { contract } : {}),
      })
    }
    return result
  }

  /* -- 盘口与逐笔（issue #39）---------------------------------------------- */

  /**
   * 盘口快照：GET /api/v3/depth（现货）或 /fapi/v1/depth（永续），limit=20 档；
   * bids 降序 / asks 升序，Binance 原生序。永续不再回落现货 depth（合约盘口
   * 落到现货端点等于把现货深度伪装成合约深度）。
   */
  async getOrderbook(symbol: string): Promise<Orderbook> {
    const { form, venueSymbol } = resolveBinanceInstrument(symbol)
    const perp = form === 'perp'
    const body = await this.#request(
      perp ? '/fapi/v1/depth' : '/api/v3/depth',
      { symbol: venueSymbol, limit: '20' },
      perp ? this.#fapiBaseUrl : this.#baseUrl,
    )
    return parseDepthBody(body, perp ? `${venueSymbol}${SWAP_SYMBOL_SUFFIX}` : venueSymbol)
  }

  /** 最近逐笔成交：GET /api/v3/trades（现货）或 /fapi/v1/trades（永续），时间升序。 */
  async getRecentTrades(symbol: string, limit = 50): Promise<TradeTick[]> {
    const { form, venueSymbol } = resolveBinanceInstrument(symbol)
    const perp = form === 'perp'
    const outputSymbol = perp ? `${venueSymbol}${SWAP_SYMBOL_SUFFIX}` : venueSymbol
    const capped = Math.max(1, Math.min(Math.floor(limit) || 50, 100))
    const body = await this.#request(
      perp ? '/fapi/v1/trades' : '/api/v3/trades',
      { symbol: venueSymbol, limit: String(capped) },
      perp ? this.#fapiBaseUrl : this.#baseUrl,
    )
    if (!Array.isArray(body)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance trades for ${outputSymbol}: unexpected response shape`)
    }
    return body.map((row) => parseTradeRow(row, outputSymbol))
  }

  /* -- USDT-M 合约公共端点（fapi，无凭证；issue #38 衍生品面板底料）---------- */
  /** 未平仓合约量：GET /fapi/v1/openInterest（openInterest 以 base 币计，time=快照 ms）。 */
  async getFuturesOpenInterest(symbol: string): Promise<{ openInterest: number; time: number }> {
    const sym = normalizeBinanceFuturesSymbol(symbol)
    const body = await this.#request('/fapi/v1/openInterest', { symbol: sym }, this.#fapiBaseUrl) as Record<string, unknown>
    const openInterest = num(body.openInterest)
    if (openInterest === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance futures openInterest for ${sym}: missing/invalid openInterest`)
    }
    return { openInterest, time: num(body.time) ?? Date.now() }
  }

  /** 最新资金费率：GET /fapi/v1/fundingRate?limit=1（[{ fundingRate, fundingTime }]，费率为小数）。 */
  async getFuturesFundingRate(symbol: string): Promise<{ fundingRate: number; fundingTime: number }> {
    const sym = normalizeBinanceFuturesSymbol(symbol)
    const body = await this.#request('/fapi/v1/fundingRate', { symbol: sym, limit: '1' }, this.#fapiBaseUrl)
    const row = (Array.isArray(body) ? body[0] : undefined) as Record<string, unknown> | undefined
    const fundingRate = num(row?.fundingRate)
    if (fundingRate === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance futures fundingRate for ${sym}: missing/invalid fundingRate`)
    }
    return { fundingRate, fundingTime: num(row?.fundingTime) ?? Date.now() }
  }

  /** 多空持仓人数比族：GET /futures/data/{globalLongShortAccountRatio|topLongShortPositionRatio}（period=1h，limit=1）。 */
  async getFuturesLongShortRatio(kind: 'global' | 'top', symbol: string): Promise<number> {
    const sym = normalizeBinanceFuturesSymbol(symbol)
    const path = kind === 'global' ? '/futures/data/globalLongShortAccountRatio' : '/futures/data/topLongShortPositionRatio'
    const body = await this.#request(path, { symbol: sym, period: '1h', limit: '1' }, this.#fapiBaseUrl)
    const row = (Array.isArray(body) ? body[0] : undefined) as Record<string, unknown> | undefined
    const ratio = num(row?.longShortRatio)
    if (ratio === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance futures ${kind} long/short ratio for ${sym}: missing/invalid longShortRatio`)
    }
    return ratio
  }

  /** 主动买卖量比：GET /futures/data/takerlongshortRatio（period=1h，limit=1，buySellRatio=买/卖）。 */
  async getFuturesTakerRatio(symbol: string): Promise<number> {
    const sym = normalizeBinanceFuturesSymbol(symbol)
    const body = await this.#request('/futures/data/takerlongshortRatio', { symbol: sym, period: '1h', limit: '1' }, this.#fapiBaseUrl)
    const row = (Array.isArray(body) ? body[0] : undefined) as Record<string, unknown> | undefined
    const ratio = num(row?.buySellRatio)
    if (ratio === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance futures taker ratio for ${sym}: missing/invalid buySellRatio`)
    }
    return ratio
  }

  /* -- 衍生品扩展（issue #54：基差卡 + 费率/OI 趋势卡底料）---------- */

  /**
   * 标记/指数价格与下期结算：GET /fapi/v1/premiumIndex —— 单端点同时携带
   * markPrice / indexPrice / lastFundingRate / nextFundingTime
   * （2026-09-03 真实网络实证，spikes/impl-crypto-derivatives）。
   */
  async getFuturesPremiumIndex(symbol: string): Promise<{
    markPrice?: number
    indexPrice?: number
    lastFundingRate?: number
    nextFundingTime?: number
    time: number
  }> {
    const sym = normalizeBinanceFuturesSymbol(symbol)
    const body = await this.#request('/fapi/v1/premiumIndex', { symbol: sym }, this.#fapiBaseUrl) as Record<string, unknown>
    const time = num(body.time)
    if (time === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance premiumIndex for ${sym}: missing/invalid time`)
    }
    const markPrice = num(body.markPrice)
    const indexPrice = num(body.indexPrice)
    const lastFundingRate = num(body.lastFundingRate)
    const nextFundingTime = num(body.nextFundingTime)
    return {
      ...(markPrice !== undefined ? { markPrice } : {}),
      ...(indexPrice !== undefined ? { indexPrice } : {}),
      ...(lastFundingRate !== undefined ? { lastFundingRate } : {}),
      ...(nextFundingTime !== undefined ? { nextFundingTime } : {}),
      time,
    }
  }

  /** 资金费率历史：GET /fapi/v1/fundingRate（时间升序；value 为小数费率）。 */
  async getFuturesFundingRateHistory(symbol: string, limit = 30): Promise<DerivativesPoint[]> {
    const sym = normalizeBinanceFuturesSymbol(symbol)
    const capped = Math.max(1, Math.min(Math.floor(limit) || 30, 100))
    const body = await this.#request('/fapi/v1/fundingRate', { symbol: sym, limit: String(capped) }, this.#fapiBaseUrl)
    if (!Array.isArray(body)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance funding history for ${sym}: unexpected response shape`)
    }
    const points: DerivativesPoint[] = []
    for (const row of body) {
      const d = row as Record<string, unknown>
      const time = num(d.fundingTime)
      const value = num(d.fundingRate)
      if (time !== undefined && value !== undefined) points.push({ time, value })
    }
    return points
  }

  /**
   * OI 历史：GET /futures/data/openInterestHist（period=1d；sumOpenInterest 为 base 币数，
   * 与快照 openInterest 同语义。2026-09-03 真实网络实证）。响应时间升序。
   */
  async getFuturesOpenInterestHistory(symbol: string, limit = 30): Promise<DerivativesPoint[]> {
    const sym = normalizeBinanceFuturesSymbol(symbol)
    const capped = Math.max(1, Math.min(Math.floor(limit) || 30, 30))
    const body = await this.#request('/futures/data/openInterestHist', { symbol: sym, period: '1d', limit: String(capped) }, this.#fapiBaseUrl)
    if (!Array.isArray(body)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Binance OI history for ${sym}: unexpected response shape`)
    }
    const points: DerivativesPoint[] = []
    for (const row of body) {
      const d = row as Record<string, unknown>
      const time = num(d.timestamp)
      const value = num(d.sumOpenInterest)
      if (time !== undefined && value !== undefined) points.push({ time, value })
    }
    return points
  }
}
