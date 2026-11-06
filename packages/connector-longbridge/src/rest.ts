import * as crypto from 'node:crypto'
import type {
  AccountBalance,
  Interval,
  Kline,
  Order,
  OrderRequest,
  Position,
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

/** `INTERVAL_VOCABULARY` 的类型面：调用方在断言后即可按穷尽联合处理周期。 */
export type SupportedInterval = (typeof INTERVAL_VOCABULARY)[number]

/**
 * 周期闸门：`@dshtrading/api` 的 `Interval` 有 15 档，本包只覆盖 8 档，表外 7 档
 * （3m/2h/4h/6h/8h/12h/3d）显式抛 `TRADING_UNSUPPORTED_INTERVAL`，不静默降级。
 * 理由：长桥 K 线在本包使用的 HTTP 路径上属文档未载，上游 `period` 接受什么字面量无凭证可测。
 */
export function assertSupportedInterval(interval: Interval): asserts interval is SupportedInterval {
  if (!(INTERVAL_VOCABULARY as readonly string[]).includes(interval)) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_INTERVAL',
      'Longbridge upstream does not serve interval "' + interval + '"; supported: ' + INTERVAL_VOCABULARY.join(', '),
    )
  }
}

export function toLongbridgePeriod(interval: Interval): string {
  assertSupportedInterval(interval)
  switch (interval) {
    case '1m': return '1m'
    case '5m': return '5m'
    case '15m': return '15m'
    case '30m': return '30m'
    case '1h': return '60m'
    case '1d': return 'day'
    case '1w': return 'week'
    case '1M': return 'month'
  }
}

export function parseIntervalMs(interval: Interval): number {
  assertSupportedInterval(interval)
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

export function toLongbridgeSymbol(raw: string): { symbol: string; canonical: string } {
  const clean = raw.trim().toUpperCase()
  if (clean.endsWith('.HK')) {
    const num = clean.replace('.HK', '').padStart(5, '0')
    return { symbol: `${num}.HK`, canonical: `${num}.HK` }
  }
  if (/^\d{1,5}$/.test(clean)) {
    const num = clean.padStart(5, '0')
    return { symbol: `${num}.HK`, canonical: `${num}.HK` }
  }
  return { symbol: clean, canonical: clean }
}

export function generateLongbridgeSignature(
  appSecret: string,
  method: string,
  pathWithQuery: string,
  headers: { authorization: string; 'x-api-key': string; 'x-timestamp': string | number },
  body = '',
): string {
  const methodUpper = method.toUpperCase()
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`
  const authVal = headers.authorization
  const apiKeyVal = headers['x-api-key']
  const tsVal = String(headers['x-timestamp'])

  const signedHeaders = 'authorization;x-api-key;x-timestamp'
  const canonicalHeaders = `authorization:${authVal}\nx-api-key:${apiKeyVal}\nx-timestamp:${tsVal}\n`
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')

  const canonicalRequest = `${methodUpper}\n${path}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`
  const signatureHex = crypto.createHmac('sha256', appSecret).update(canonicalRequest, 'utf8').digest('hex')

  return `HMAC-SHA256 SignedHeaders=${signedHeaders}, Signature=${signatureHex}`
}

export interface LongbridgeRestOptions {
  baseUrl?: string
  appKey?: string
  appSecret?: string
  accessToken?: string
  fetchImpl?: typeof fetch
}

export class LongbridgeRestClient {
  readonly baseUrl: string
  readonly appKey?: string
  readonly appSecret?: string
  readonly accessToken?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: LongbridgeRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? (process.env.LONGBRIDGE_API_URL || 'https://openapi.longportapp.com')
    this.appKey = options.appKey ?? process.env.LONGBRIDGE_APP_KEY
    this.appSecret = options.appSecret ?? process.env.LONGBRIDGE_APP_SECRET
    this.accessToken = options.accessToken ?? process.env.LONGBRIDGE_ACCESS_TOKEN
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase()
    const url = `${this.baseUrl}${path}`
    const timestamp = Date.now().toString()
    const bodyStr = options.body ? String(options.body) : ''

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    }

    if (this.accessToken) {
      headers['authorization'] = this.accessToken.startsWith('Bearer ') ? this.accessToken : `Bearer ${this.accessToken}`
    }
    if (this.appKey) {
      headers['x-api-key'] = this.appKey
      headers['x-timestamp'] = timestamp
      if (this.appSecret && headers['authorization']) {
        headers['x-api-signature'] = generateLongbridgeSignature(
          this.appSecret,
          method,
          path,
          {
            authorization: headers['authorization'],
            'x-api-key': this.appKey,
            'x-timestamp': timestamp,
          },
          bodyStr,
        )
      }
    }

    try {
      const res = await this.fetchImpl(url, { ...options, headers })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Longbridge HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Longbridge network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { symbol: lbSymbol, canonical } = toLongbridgeSymbol(symbol)
    const data = await this.requestJson<{
      code: number
      data?: Array<{ symbol: string; last_done: string; volume: string; timestamp: number }>
    }>(`/v1/quote/realtime?symbol=${encodeURIComponent(lbSymbol)}`)

    if (data.code !== 0 || !data.data || data.data.length === 0) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Longbridge quote not found for ${symbol}`)
    }

    const row = data.data[0]
    const price = parseFloat(row.last_done || '0')
    const volume = parseFloat(row.volume || '0')
    const timestamp = row.timestamp ? row.timestamp * 1000 : Date.now()

    return {
      symbol: canonical,
      price,
      volume,
      timestamp,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    assertSupportedInterval(interval)
    const { symbol: lbSymbol } = toLongbridgeSymbol(symbol)
    const period = toLongbridgePeriod(interval)
    const stepMs = parseIntervalMs(interval)

    const data = await this.requestJson<{
      code: number
      data?: {
        candlesticks?: Array<{
          open: string
          close: string
          high: string
          low: string
          volume: string
          timestamp: number
        }>
      }
    }>(`/v1/quote/candlesticks?symbol=${encodeURIComponent(lbSymbol)}&period=${period}&count=${limit}`)

    if (data.code !== 0 || !data.data?.candlesticks) {
      return []
    }

    return data.data.candlesticks.map((c) => {
      const openTime = c.timestamp * 1000
      return {
        openTime,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
        closeTime: openTime + stepMs - 1,
      }
    })
  }

  async getBalance(): Promise<AccountBalance> {
    if (!this.appKey || !this.accessToken) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Longbridge: appKey and accessToken are required for getBalance')
    }
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: {
        list?: Array<{
          total_cash?: string
          net_assets?: string
          currency?: string
        }>
      }
    }>('/v1/asset/account')

    const first = res.data?.list?.[0]
    if (res.code !== 0 || first === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Longbridge getBalance failed: ' + (res.message ?? ('code ' + res.code)))
    }

    const cash = parseFloat(first.total_cash || '0')
    const netAssets = parseFloat(first.net_assets || first.total_cash || '0')
    // api 的 AccountBalance 是 { asset, free, locked }：上游 currency / total_cash / net_assets
    // 一一对位（asset 是结算币种，与 connector-alpaca 的 asset: data.currency 同口径），
    // locked 取非现金资产 = 净值 - 可用现金，使面板「合计 = free + locked」恰为总资产。
    return {
      asset: first.currency ?? 'HKD',
      free: cash,
      locked: Math.max(netAssets - cash, 0),
    }
  }

  /**
   * 持仓快照。**当前显式拒绝，不产出任何行**——上游没有 api 契约要求的那两样真数据：
   *
   * - api 的 `Position` 必填 `side: 'long' | 'short'` 与 `timestamp: number`
   *   （packages/api/src/index.ts:499-520，size 的注释明写「正数；方向由 side 表达」）。
   * - 长桥文档化的持仓端点是 `GET /v1/asset/stock`，应答 `data.list[].stock_info[]`
   *   只有 symbol / symbol_name / currency / quantity / market / available_quantity /
   *   cost_price / init_quantity；官方 SDK 的 `StockPosition`（longport 4.3.7
   *   index.d.ts:2377-2399）字段集完全一致，同样没有方向、也没有持仓时间。
   * - `quantity` 是持股数，不是带符号的仓位：`quantity > 0 ? 'long' : 'short'` 这种填充
   *   只要上游给的是绝对值，就把所有空头标成多头——那是把「数量空白 + 恒显示空头」换成一个
   *   更难发现的方向错误。`timestamp` 同理没有来源，拿 Date.now() 冒充持仓时间也是编数据。
   *
   * 裁决与 connector-futu / connector-bybit / connector-ccxt 的持仓读数同款：不可用就
   * TRADING_NOT_IMPLEMENTED，绝不返回空数组（空数组的语义是「没有持仓」，与「读不到」是两句
   * 不同的话）。解除条件见 README「持仓（getPositions）」一节。
   */
  async getPositions(): Promise<Position[]> {
    if (!this.appKey || !this.accessToken) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Longbridge: appKey and accessToken are required for getPositions')
    }
    throw new TradingServiceError(
      'TRADING_NOT_IMPLEMENTED',
      'Longbridge TradeService.getPositions is not available: @dshtrading/api Position requires side (long|short) and '
        + 'timestamp, and the Longbridge stock-position snapshot provides neither. The documented endpoint GET '
        + '/v1/asset/stock answers data.list[].stock_info[] with only symbol, symbol_name, currency, quantity, market, '
        + 'available_quantity, cost_price and init_quantity (the official SDK StockPosition carries the same field set). '
        + 'quantity is a holding count rather than a signed size, so direction cannot be derived, and there is no open '
        + 'time to report. That means "not available", NOT "no positions".',
    )
  }

  async placeOrder(_creds: unknown, req: OrderRequest, remark?: string): Promise<Order> {
    if (!this.appKey || !this.accessToken) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Longbridge: appKey and accessToken are required for placeOrder')
    }
    const { symbol: lbSymbol, canonical } = toLongbridgeSymbol(req.symbol)
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: { order_id?: string }
    }>('/v1/trade/order', {
      method: 'POST',
      body: JSON.stringify({
        symbol: lbSymbol,
        order_type: req.type === 'market' ? 'MO' : 'LO',
        side: req.side === 'buy' ? 'Buy' : 'Sell',
        submitted_quantity: String(req.quantity),
        submitted_price: req.price ? String(req.price) : undefined,
        time_in_force: 'Day',
        // Longbridge 官方 submit_order 的 remark（仅对账标签，不是幂等键）。
        ...(remark !== undefined ? { remark } : {}),
      }),
    })

    if (res.code !== 0 || !res.data?.order_id) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Longbridge placeOrder failed: ${res.message ?? `code ${res.code}`}`)
    }

    return {
      id: res.data.order_id,
      symbol: canonical,
      side: req.side,
      type: req.type,
      status: 'new',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(_creds: unknown, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    if (!this.appKey || !this.accessToken) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Longbridge: appKey and accessToken are required for cancelOrder')
    }
    const res = await this.requestJson<{ code: number; message?: string }>(`/v1/trade/order?order_id=${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
    })

    if (res.code !== 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Longbridge cancelOrder failed: ${res.message ?? `code ${res.code}`}`)
    }

    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }
