/**
 * @dshtrading/connector-bybit/rest
 * Bybit API v5 REST 客户端（支持公共行情与现货/衍生品交易）。
 */

import {
  SWAP_SYMBOL_SUFFIX,
  instrumentFormOf,
  type DerivativesPoint,
  type AccountBalance,
  type InstrumentAssetClass,
  type InstrumentContract,
  type InstrumentForm,
  type InstrumentRef,
  type Interval,
  type Kline,
  type Order,
  type Orderbook,
  type OrderbookLevel,
  type OrderRequest,
  type Position,
  type Ticker,
  type TradeTick,
  type TradingErrorCode,
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

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'] as const

export function toBybitInterval(interval: Interval): string {
  switch (interval) {
    case '1m': return '1'
    case '5m': return '5'
    case '15m': return '15'
    case '30m': return '30'
    case '1h': return '60'
    case '4h': return '240'
    case '1d': return 'D'
    case '1w': return 'W'
    case '1M': return 'M'
  }
}

export function parseIntervalMs(interval: Interval): number {
  switch (interval) {
    case '1m': return 60 * 1000
    case '5m': return 5 * 60 * 1000
    case '15m': return 15 * 60 * 1000
    case '30m': return 30 * 60 * 1000
    case '1h': return 60 * 60 * 1000
    case '4h': return 4 * 60 * 60 * 1000
    case '1d': return 24 * 60 * 60 * 1000
    case '1w': return 7 * 24 * 60 * 60 * 1000
    case '1M': return 30 * 24 * 60 * 60 * 1000
  }
}

/** 入参符号的形态裁决结果（交易所侧符号 + 规范形）。 */
export interface ParsedCryptoSymbol {
  /** 交易所侧符号（无 `-SWAP` 后缀）：Bybit 现货与线性永续同形，如 BTCUSDT。 */
  readonly base: string
  readonly form: InstrumentForm
  /** 市场规范形：spot=BTCUSDT、perp=BTCUSDT-SWAP（输出纪律用）。 */
  readonly canonical: string
}

/**
 * 解析入参符号：形态由规范后缀裁决（复用 @dshtrading/api 的 instrumentFormOf，
 * 连接器不自写 endsWith('-SWAP')）。
 * `-SWAP` 必须整段剥掉再做分隔符清理——否则 BTCUSDT-SWAP 会被揉成 BTCUSDTSWAP，
 * Bybit 查无此标的（issue #54 评审 M2）。
 */
export function parseCryptoSymbol(raw: string): ParsedCryptoSymbol {
  const form = instrumentFormOf(raw)
  const base = raw.trim().toUpperCase().replace(/-SWAP$/, '').replace(/[-_/]/g, '')
  if (!base) throw new TradingServiceError('TRADING_INVALID_ARGUMENT', 'Symbol cannot be empty')
  return { base, form, canonical: form === 'perp' ? `${base}${SWAP_SYMBOL_SUFFIX}` : base }
}

/**
 * 交易所侧符号（无形态后缀）。
 * 只做归一化、不表达形态：**凡可能收到 `-SWAP` 的行情路径必须改用
 * parseCryptoSymbol 并按 form 分 category**，否则永续会被静默打到现货端点
 * （P3 硬不变量：任何路径不得把 -SWAP 落到 spot 端点）。
 */
export function normalizeCryptoSymbol(raw: string): string {
  return parseCryptoSymbol(raw).base
}

/** Bybit v5 market 的 category：形态的唯一分岔（spot / linear），端点与响应形状一致。 */
export function bybitCategory(form: InstrumentForm): 'spot' | 'linear' {
  return form === 'perp' ? 'linear' : 'spot'
}

/** 宽松转 number（字符串/数字皆收，非有限值返回 undefined）。 */
function num(value: unknown): number | undefined {
  // 空串不是 0（Number('')===0 的 JS 坑）：上游「未发布」字段（如 OKX nextFundingRate）
  // 用空串表达，必须缺省而非编造 0（issue #54 评审 M1，spikes EVIDENCE 实证）。
  if (value === '') return undefined
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** 线性永续 instruments-info 行 → contract 元数据（字段缺失一律缺省，不本地推断）。 */
function parseContractMeta(row: Record<string, unknown>): InstrumentContract | undefined {
  const lot = asRecord(row.lotSizeFilter)
  const price = asRecord(row.priceFilter)
  const leverage = asRecord(row.leverageFilter)
  const multiplier = num(row.contractSize)
  const tickSize = num(price?.tickSize)
  const lotSize = num(lot?.qtyStep)
  const maxLeverage = num(leverage?.maxLeverage)
  const settleCcy = typeof row.settleCoin === 'string' && row.settleCoin !== '' ? row.settleCoin : undefined
  const contract: InstrumentContract = {
    ...(multiplier !== undefined ? { multiplier } : {}),
    ...(tickSize !== undefined ? { tickSize } : {}),
    ...(lotSize !== undefined ? { lotSize } : {}),
    ...(maxLeverage !== undefined ? { maxLeverage } : {}),
    ...(settleCcy !== undefined ? { settleCcy } : {}),
  }
  return Object.keys(contract).length > 0 ? contract : undefined
}

/**
 * Bybit `symbolType` 字面量 → 资产类别标签。
 *
 * `symbolType` 是 instruments-info 行上的**可选**分类字段，官方枚举页列出的取值有
 * innovation/adventure/xstocks/commodity/stock/forex/ETF/mstocks。2026-10-08 可达环境实测
 * （线性 893 行 + 现货 528 行，见 spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md）：
 * 线性侧 stock 202 / innovation 128 / ETF 54 / commodity 4 / forex 3 / 空串 502；
 * 现货侧 空串 514 / xstocks 11（NVDAXUSDT、AAPLXUSDT 等代币化股票）/ adventure 3。
 *
 * 只登记**实测过的**字面量：
 * - 空串 = 交易所没给分类（标准加密品种）⇒ **留空而不是推断成 crypto**（不变量：取不到即留空，
 *   漏标而非错标；空串不是分类值）。
 * - `forex`（EURUSD/GBPUSD/USDJPY）与 `mstocks` 未登记：枚举无外汇成员，mstocks 未在实测中出现；
 *   要不要扩枚举属契约层决定，不在本连接器内定。
 */
const BYBIT_SYMBOL_TYPE_ASSET_CLASS: Readonly<Record<string, InstrumentAssetClass>> = {
  innovation: 'crypto',
  adventure: 'crypto',
  stock: 'equity',
  ETF: 'equity',
  xstocks: 'equity',
  commodity: 'commodity',
}

/** symbolType → 资产类别；空串/未登记/缺失 = undefined（不推断）。 */
export function bybitAssetClassOf(symbolType: unknown): InstrumentAssetClass | undefined {
  if (typeof symbolType !== 'string') return undefined
  return BYBIT_SYMBOL_TYPE_ASSET_CLASS[symbolType.trim()]
}

/**
 * instruments-info 行 → InstrumentRef（输出规范形）。
 * assetClass 只由交易所 `symbolType` 字面量裁决（现货与线性同一规则）；交易所没给
 * （空串/未登记）即留空，绝不按符号猜（硬不变量 #2：TradFi 归属只信交易所元数据）。
 */
function toInstrumentRef(row: Record<string, unknown>, form: InstrumentForm): InstrumentRef | undefined {
  // 规范形由交易所自带 symbol 派生：不拿 baseCoin+quoteCoin 拼——Bybit 线性面除
  // `BTCUSDT` 还有 `BTCPERP`（USDC 永续）等符号形与 BASEQUOTE 不一致的品种，
  // 拼出来的名字交易所不认（发出去必 404）。
  const exchangeSymbol = typeof row.symbol === 'string' ? row.symbol.trim().toUpperCase() : ''
  if (exchangeSymbol === '') return undefined
  const assetClass = bybitAssetClassOf(row.symbolType)
  if (form === 'spot') {
    return { symbol: exchangeSymbol, form, ...(assetClass !== undefined ? { assetClass } : {}) }
  }
  const contract = parseContractMeta(row)
  return {
    symbol: `${exchangeSymbol}${SWAP_SYMBOL_SUFFIX}`,
    form,
    ...(assetClass !== undefined ? { assetClass } : {}),
    ...(contract !== undefined ? { contract } : {}),
  }
}

export interface BybitRestOptions {
  baseUrl?: string
  apiKey?: string
  apiSecret?: string
  fetchImpl?: typeof fetch
}

export class BybitRestClient {
  readonly baseUrl: string
  private readonly apiKey?: string
  private readonly apiSecret?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: BybitRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://api.bybit.com'
    this.apiKey = options.apiKey
    this.apiSecret = options.apiSecret
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Bybit HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Bybit network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  /**
   * 公共 ticker：现货 → `category=spot`，永续（`-SWAP`）→ `category=linear`。
   * 形态只由规范后缀裁决；永续请求绝不回落现货端点。输出 symbol 为规范形。
   */
  async getTicker(symbol: string): Promise<Ticker> {
    const { base: sym, form, canonical } = parseCryptoSymbol(symbol)
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: {
        list?: Array<{
          symbol: string
          lastPrice: string
          prevPrice24h?: string
          price24hPcnt?: string
          volume24h: string
          time?: number
        }>
      }
    }>(`/v5/market/tickers?category=${bybitCategory(form)}&symbol=${sym}`)

    if (data.retCode !== 0 || !data.result?.list || data.result.list.length === 0) {
      // 统一用词汇表内的 TRADING_UNSUPPORTED_SYMBOL：Bybit 对不存在的标的回 retCode 0 + 空列表，
      // 永续查无此合约必须报「不支持」而不是无码可用（TRADING_SYMBOL_NOT_FOUND 不在 TradingErrorCode 里）。
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Bybit ticker not found for ${canonical} (category=${bybitCategory(form)})`)
    }

    const row = data.result.list[0]!
    const price = parseFloat(row.lastPrice)
    const volume = parseFloat(row.volume24h)
    const timestamp = row.time ? row.time : Date.now()
    const prevClose = row.prevPrice24h ? parseFloat(row.prevPrice24h) : undefined
    const changePercent = row.price24hPcnt ? parseFloat(row.price24hPcnt) * 100 : undefined

    return {
      symbol: canonical,
      price,
      volume,
      timestamp,
      ...(prevClose !== undefined && Number.isFinite(prevClose) ? { prevClose } : {}),
      ...(changePercent !== undefined && Number.isFinite(changePercent) ? { changePercent } : {}),
    }
  }

  /** 公共 K 线：与 getTicker 同一条形态分岔（spot / linear）。 */
  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { base: sym, form } = parseCryptoSymbol(symbol)
    const bybitInt = toBybitInterval(interval)
    const stepMs = parseIntervalMs(interval)

    const data = await this.requestJson<{
      retCode: number
      result?: {
        list?: Array<[string, string, string, string, string, string, string]>
      }
    }>(`/v5/market/kline?category=${bybitCategory(form)}&symbol=${sym}&interval=${bybitInt}&limit=${limit}`)

    if (data.retCode !== 0 || !data.result?.list) {
      return []
    }

    const list = [...data.result.list].reverse()
    return list.map((r) => {
      const openTime = parseInt(r[0], 10)
      return {
        openTime,
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5]),
        closeTime: openTime + stepMs - 1,
      }
    })
  }

  /* -- 标的名册（P3：现货 ∪ 线性永续）---------------------------------------- */

  /** instruments-info 单页（limit=1000；游标翻页由 #collectInstrumentRows 驱动）。 */
  async #fetchInstrumentPage(category: 'spot' | 'linear', cursor?: string): Promise<{ list: Array<Record<string, unknown>>; next?: string }> {
    const query = `/v5/market/instruments-info?category=${category}&limit=1000`
      + (cursor !== undefined && cursor !== '' ? `&cursor=${encodeURIComponent(cursor)}` : '')
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: { list?: Array<Record<string, unknown>>; nextPageCursor?: string }
    }>(query)
    if (data.retCode !== 0 || !Array.isArray(data.result?.list)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit instruments-info (${category}): ${data.retMsg}`)
    }
    const next = data.result?.nextPageCursor
    return { list: data.result.list, ...(typeof next === 'string' && next !== '' ? { next } : {}) }
  }

  async #collectInstrumentRows(category: 'spot' | 'linear'): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const page = await this.#fetchInstrumentPage(category, cursor)
      rows.push(...page.list)
      if (page.next === undefined) return rows
      // 上游回同一个游标就不再有新页：缺这道守卫会变成无界翻页（越翻越占内存）。
      if (seen.has(page.next)) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit instruments-info (${category}): upstream repeated page cursor ${page.next}`)
      }
      seen.add(page.next)
      cursor = page.next
    }
  }

  /**
   * 标的名册：现货 ∪ 线性永续（只收 status=Trading；线性侧还要求 contractType=LinearPerpetual，
   * instruments-info 会连已交割/预上市行一起返回）。输出规范形 + form + contract 原样透传。
   */
  async listInstruments(): Promise<InstrumentRef[]> {
    const [spotRows, linearRows] = await Promise.all([
      this.#collectInstrumentRows('spot'),
      this.#collectInstrumentRows('linear'),
    ])
    const out: InstrumentRef[] = []
    for (const row of spotRows) {
      if (row.status !== 'Trading') continue
      const ref = toInstrumentRef(row, 'spot')
      if (ref !== undefined) out.push(ref)
    }
    for (const row of linearRows) {
      if (row.contractType !== 'LinearPerpetual' || row.status !== 'Trading') continue
      const ref = toInstrumentRef(row, 'perp')
      if (ref !== undefined) out.push(ref)
    }
    return out
  }

  /* -- 线性合约（U 本位永续）公共端点（issue #38 衍生品面板底料）------------- */

  /**
   * 线性合约行情行：GET /v5/market/tickers?category=linear —— 单端点同时携带
   * fundingRate（当前资金费率，小数）、openInterest（base 币计持仓量）、
   * openInterestValue（USD 计价值）。
   */
  async getLinearTickerSnapshot(symbol: string): Promise<{
    symbol: string
    fundingRate?: number
    openInterest?: number
    openInterestValue?: number
    nextFundingTime?: number
    markPrice?: number
    indexPrice?: number
  }> {
    const sym = normalizeCryptoSymbol(symbol)
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: { list?: Array<Record<string, unknown>> }
    }>(`/v5/market/tickers?category=linear&symbol=${sym}`)
    if (data.retCode !== 0 || !data.result?.list || data.result.list.length === 0) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Bybit linear tickers not found for ${sym}`)
    }
    const row = data.result.list[0] as Record<string, unknown>
    const fundingRate = num(row.fundingRate)
    const openInterest = num(row.openInterest)
    const openInterestValue = num(row.openInterestValue)
    // issue #54：同行还携带 nextFundingTime / markPrice / indexPrice（基差卡 + 倒计时底料）。
    const nextFundingTime = num(row.nextFundingTime)
    const markPrice = num(row.markPrice)
    const indexPrice = num(row.indexPrice)
    return {
      symbol: typeof row.symbol === 'string' && row.symbol ? row.symbol : sym,
      ...(fundingRate !== undefined ? { fundingRate } : {}),
      ...(openInterest !== undefined ? { openInterest } : {}),
      ...(openInterestValue !== undefined ? { openInterestValue } : {}),
      ...(nextFundingTime !== undefined ? { nextFundingTime } : {}),
      ...(markPrice !== undefined ? { markPrice } : {}),
      ...(indexPrice !== undefined ? { indexPrice } : {}),
    }
  }

  /** 多空账户人数比：GET /v5/market/account-ratio?category=linear（period=1h，limit=1，buyRatio/sellRatio 为账户占比）。 */
  async getLinearAccountRatio(symbol: string): Promise<{ buyRatio: number; sellRatio: number }> {
    const sym = normalizeCryptoSymbol(symbol)
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: { list?: Array<Record<string, unknown>> }
    }>(`/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=1`)
    if (data.retCode !== 0 || !data.result?.list || data.result.list.length === 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit account ratio not found for ${sym}`)
    }
    const row = data.result.list[0] as Record<string, unknown>
    const buyRatio = num(row.buyRatio)
    const sellRatio = num(row.sellRatio)
    if (buyRatio === undefined || sellRatio === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit account ratio for ${sym}: missing/invalid buyRatio/sellRatio`)
    }
    return { buyRatio, sellRatio }
  }


  /* -- 衍生品扩展（issue #54：费率/OI 趋势卡底料）------------------------- */

  /** 资金费率历史：GET /v5/market/funding/history?category=linear（响应新→旧 → 反转升序）。 */
  async getLinearFundingHistory(symbol: string, limit = 30): Promise<DerivativesPoint[]> {
    const sym = normalizeCryptoSymbol(symbol)
    const capped = Math.max(1, Math.min(Math.floor(limit) || 30, 100))
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: { list?: Array<Record<string, unknown>> }
    }>(`/v5/market/funding/history?category=linear&symbol=${sym}&limit=${capped}`)
    if (data.retCode !== 0 || !Array.isArray(data.result?.list)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit funding history for ${sym}: ${data.retMsg}`)
    }
    const points: DerivativesPoint[] = []
    for (const row of data.result.list) {
      const time = num(row.fundingRateTimestamp)
      const value = num(row.fundingRate)
      if (time !== undefined && value !== undefined) points.push({ time, value })
    }
    return points.reverse()
  }

  /**
   * OI 历史：GET /v5/market/open-interest?category=linear&intervalTime=1d
   * （openInterest 为 base 币数，与快照同语义；响应新→旧 → 反转升序。
   * 2026-09-03 真实网络实证，spikes/impl-crypto-derivatives）。
   */
  async getLinearOpenInterestHistory(symbol: string, limit = 30): Promise<DerivativesPoint[]> {
    const sym = normalizeCryptoSymbol(symbol)
    const capped = Math.max(1, Math.min(Math.floor(limit) || 30, 50))
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: { list?: Array<Record<string, unknown>> }
    }>(`/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=1d&limit=${capped}`)
    if (data.retCode !== 0 || !Array.isArray(data.result?.list)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit OI history for ${sym}: ${data.retMsg}`)
    }
    const points: DerivativesPoint[] = []
    for (const row of data.result.list) {
      const time = num(row.timestamp)
      const value = num(row.openInterest)
      if (time !== undefined && value !== undefined) points.push({ time, value })
    }
    return points.reverse()
  }

  /* -- 盘口与逐笔（issue #39）---------------------------------------------- */

  /** orderbook 档位行 [price, size] → OrderbookLevel。 */
  #parseBookRow(row: unknown): OrderbookLevel | undefined {
    if (!Array.isArray(row) || row.length < 2) return undefined
    const price = num(row[0])
    const amount = num(row[1])
    if (price === undefined || amount === undefined || price <= 0 || amount <= 0) return undefined
    return { price, amount }
  }

  /**
   * 盘口快照：GET /v5/market/orderbook?category=spot（limit=25）。
   * v5 盘口字段是缩写 `result.b`（bids 降序）/ `result.a`（asks 升序）——不是
   * bids/asks 全称（2026-09-02 真实响应实证，spikes/impl-orderbook-ticks/bybit-orderbook-raw.json）。
   */
  async getOrderbook(symbol: string): Promise<Orderbook> {
    const { base: sym, form, canonical } = parseCryptoSymbol(symbol)
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: { b?: unknown[]; a?: unknown[]; ts?: number }
    }>(`/v5/market/orderbook?category=${bybitCategory(form)}&symbol=${sym}&limit=25`)
    if (data.retCode !== 0 || !Array.isArray(data.result?.b) || !Array.isArray(data.result?.a)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit orderbook for ${canonical}: unexpected response shape`)
    }
    const bids = (data.result.b as unknown[]).map(row => this.#parseBookRow(row)).filter((l): l is OrderbookLevel => l !== undefined)
    const asks = (data.result.a as unknown[]).map(row => this.#parseBookRow(row)).filter((l): l is OrderbookLevel => l !== undefined)
    return { symbol: canonical, bids, asks, timestamp: num(data.result.ts) ?? Date.now() }
  }

  /** recent-trade 行 → TradeTick（side 即 taker 方向，Bybit 大写词汇；响应新→旧 → 反转升序）。 */
  #parseTradeRow(row: Record<string, unknown>, symbol: string): TradeTick {
    const price = num(row.price)
    const amount = num(row.size)
    if (price === undefined || amount === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit trades for ${symbol}: malformed trade row`)
    }
    const rawSide = typeof row.side === 'string' ? row.side.toLowerCase() : ''
    const side = rawSide === 'buy' || rawSide === 'sell' ? rawSide : 'unknown'
    return {
      id: String(row.execId ?? ''),
      symbol,
      price,
      amount,
      side,
      timestamp: num(row.time) ?? Date.now(),
    }
  }

  /** 最近逐笔成交：GET /v5/market/recent-trade?category=spot（响应新→旧 → 反转升序）。 */
  async getRecentTrades(symbol: string, limit = 50): Promise<TradeTick[]> {
    const { base: sym, form, canonical } = parseCryptoSymbol(symbol)
    const capped = Math.max(1, Math.min(Math.floor(limit) || 50, 60))
    const data = await this.requestJson<{
      retCode: number
      retMsg: string
      result?: { list?: Array<Record<string, unknown>> }
    }>(`/v5/market/recent-trade?category=${bybitCategory(form)}&symbol=${sym}&limit=${capped}`)
    if (data.retCode !== 0 || !data.result?.list) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Bybit trades for ${canonical}: unexpected response shape`)
    }
    return (data.result.list as Array<Record<string, unknown>>)
      .map(row => this.#parseTradeRow(row, canonical))
      .reverse()
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    const sym = normalizeCryptoSymbol(req.symbol)
    return {
      id: `sim-bybit-${Date.now()}`,
      symbol: sym,
      side: req.side,
      type: req.type,
      status: 'filled',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: true,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(_creds: unknown, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }
