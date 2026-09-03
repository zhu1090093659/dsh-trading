/**
 * Alpaca REST 客户端 —— 美股市场 (us) 行情与交易数据面。
 *
 * 数据面端点 (Market Data v2): https://data.alpaca.markets/v2
 * 交易面端点 (Trading API v2):
 *  - Paper (模拟): https://paper-api.alpaca.markets/v2
 *  - Live  (实盘): https://api.alpaca.markets/v2
 *
 * 鉴权头:
 *  - APCA-API-KEY-ID: key
 *  - APCA-API-SECRET-KEY: secret
 *
 * @module @dshtrading/connector-alpaca/rest
 */

import type {
  AccountBalance,
  Interval,
  Kline,
  Order,
  Orderbook,
  Position,
  Ticker,
  TradeFill,
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

export interface AlpacaRestOptions {
  dataBaseUrl?: string
  tradingBaseUrl?: string
  env?: 'demo' | 'live'
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface AlpacaCredentials {
  readonly key: string
  readonly secret: string
}

export const INTERVAL_TO_ALPACA: Record<Interval, string> = {
  '1m': '1Min',
  '5m': '5Min',
  '15m': '15Min',
  '30m': '30Min',
  '1h': '1Hour',
  '4h': '4Hour',
  '1d': '1Day',
  '1w': '1Week',
  '1M': '1Month',
}

const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 1000,
  '1M': 30 * 24 * 60 * 1000,
}

export const INTERVAL_VOCABULARY = Object.keys(INTERVAL_TO_ALPACA) as Interval[]

export function normalizeUsSymbol(raw: string): string {
  const s = raw.trim().toUpperCase()
  if (!/^[A-Z]{1,10}(\.[A-Z]{1,4})?$/.test(s)) {
    throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Alpaca: malformed US symbol ${JSON.stringify(raw)}`)
  }
  return s
}

export class AlpacaRestClient {
  private readonly dataBaseUrl: string
  private readonly tradingBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: AlpacaRestOptions = {}) {
    this.dataBaseUrl = (options.dataBaseUrl ?? 'https://data.alpaca.markets/v2').replace(/\/+$/, '')
    const defaultTrading = options.env === 'live'
      ? 'https://api.alpaca.markets/v2'
      : 'https://paper-api.alpaca.markets/v2'
    this.tradingBaseUrl = (options.tradingBaseUrl ?? defaultTrading).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  private buildHeaders(credentials?: AlpacaCredentials): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
    }
    if (credentials?.key && credentials?.secret) {
      headers['APCA-API-KEY-ID'] = credentials.key
      headers['APCA-API-SECRET-KEY'] = credentials.secret
    }
    return headers
  }

  private async request(
    baseUrl: string,
    path: string,
    init: RequestInit = {},
    credentials?: AlpacaCredentials,
  ): Promise<unknown> {
    const url = baseUrl + (path.startsWith('/') ? path : '/' + path)
    const headers = { ...this.buildHeaders(credentials), ...(init.headers as Record<string, string>) }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, { ...init, headers, signal: controller.signal })
      if (!res.ok) {
        let errBody: unknown
        try { errBody = await res.json() } catch { errBody = await res.text().catch(() => '') }
        const msg = typeof errBody === 'object' && errBody !== null && 'message' in errBody
          ? String((errBody as { message: unknown }).message)
          : String(errBody ?? res.statusText)

        if (res.status === 401 || res.status === 403) {
          throw new TradingServiceError('TRADING_AUTH_FAILED', `Alpaca auth failed (${res.status}): ${msg}`)
        }
        if (res.status === 429) {
          throw new TradingServiceError('TRADING_RATE_LIMITED', `Alpaca rate limited (429): ${msg}`)
        }
        if (res.status === 404) {
          throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Alpaca not found (404): ${msg}`)
        }
        if (res.status === 422) {
          if (/insufficient|buying power|balance/i.test(msg)) {
            throw new TradingServiceError('TRADING_INSUFFICIENT_BALANCE', `Alpaca balance error (422): ${msg}`)
          }
          throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Alpaca invalid parameters (422): ${msg}`)
        }
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Alpaca HTTP ${res.status}: ${msg}`)
      }
      return await res.json()
    } catch (error) {
      if (error instanceof TradingServiceError) throw error
      throw new TradingServiceError('TRADING_NETWORK', error instanceof Error ? error.message : String(error), error)
    } finally {
      clearTimeout(timer)
    }
  }

  async getTicker(symbol: string, credentials?: AlpacaCredentials): Promise<Ticker> {
    const sym = normalizeUsSymbol(symbol)
    const [tradeRes, quoteRes] = await Promise.allSettled([
      this.request(this.dataBaseUrl, `/stocks/${sym}/trades/latest?feed=iex`, { method: 'GET' }, credentials),
      this.request(this.dataBaseUrl, `/stocks/${sym}/quotes/latest?feed=iex`, { method: 'GET' }, credentials),
    ])

    if (tradeRes.status === 'rejected' && quoteRes.status === 'rejected') {
      throw tradeRes.reason
    }

    let price = 0
    let timestamp = Date.now()
    if (tradeRes.status === 'fulfilled') {
      const data = tradeRes.value as { trade?: { p?: number; t?: string } }
      if (typeof data?.trade?.p === 'number') {
        price = data.trade.p
      }
      if (typeof data?.trade?.t === 'string') {
        timestamp = new Date(data.trade.t).getTime()
      }
    }

    let bid: number | undefined
    let ask: number | undefined
    if (quoteRes.status === 'fulfilled') {
      const data = quoteRes.value as { quote?: { bp?: number; ap?: number; t?: string } }
      if (typeof data?.quote?.bp === 'number' && data.quote.bp > 0) bid = data.quote.bp
      if (typeof data?.quote?.ap === 'number' && data.quote.ap > 0) ask = data.quote.ap
      if (price === 0 && bid !== undefined && ask !== undefined) {
        price = (bid + ask) / 2
        if (typeof data?.quote?.t === 'string') timestamp = new Date(data.quote.t).getTime()
      }
    }

    return {
      symbol: sym,
      price,
      timestamp,
      ...(bid !== undefined ? { bid } : {}),
      ...(ask !== undefined ? { ask } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval, limit = 100, credentials?: AlpacaCredentials): Promise<Kline[]> {
    const sym = normalizeUsSymbol(symbol)
    const tf = INTERVAL_TO_ALPACA[interval]
    if (!tf) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_INTERVAL', `Alpaca: unsupported interval ${String(interval)}`)
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000)
    const path = `/stocks/bars?symbols=${sym}&timeframe=${tf}&limit=${safeLimit}&feed=iex&adjustment=split`
    const body = await this.request(this.dataBaseUrl, path, { method: 'GET' }, credentials) as { bars?: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> }

    const rawBars = body?.bars?.[sym] ?? []
    const duration = INTERVAL_MS[interval] ?? 24 * 60 * 60 * 1000

    return rawBars.map((bar) => {
      const openTime = new Date(bar.t).getTime()
      return {
        openTime,
        open: Number(bar.o),
        high: Number(bar.h),
        low: Number(bar.l),
        close: Number(bar.c),
        volume: Number(bar.v),
        closeTime: openTime + duration - 1,
      }
    })
  }

  async listInstruments(credentials?: AlpacaCredentials): Promise<Array<{ symbol: string; name?: string }>> {
    const path = '/assets?status=active&asset_class=us_equity'
    const body = await this.request(this.tradingBaseUrl, path, { method: 'GET' }, credentials)
    if (!Array.isArray(body)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Alpaca assets: invalid response shape')
    }
    const result: Array<{ symbol: string; name?: string }> = []
    for (const item of body) {
      if (item && item.tradable && typeof item.symbol === 'string' && item.symbol) {
        result.push({ symbol: item.symbol, ...(item.name ? { name: String(item.name) } : {}) })
      }
    }
    return result
  }

  async getOrderbook(symbol: string, credentials?: AlpacaCredentials): Promise<Orderbook> {
    const sym = normalizeUsSymbol(symbol)
    const quoteRes = await this.request(this.dataBaseUrl, `/stocks/${sym}/quotes/latest?feed=iex`, { method: 'GET' }, credentials) as { quote?: { bp?: number; ap?: number; bs?: number; as?: number; t?: string } }
    const q = quoteRes?.quote
    const bids: Array<{ price: number; amount: number }> = []
    const asks: Array<{ price: number; amount: number }> = []
    if (typeof q?.bp === 'number' && q.bp > 0) {
      bids.push({ price: q.bp, amount: Number(q.bs ?? 100) })
    }
    if (typeof q?.ap === 'number' && q.ap > 0) {
      asks.push({ price: q.ap, amount: Number(q.as ?? 100) })
    }
    return {
      symbol: sym,
      bids,
      asks,
      timestamp: q?.t ? new Date(q.t).getTime() : Date.now(),
    }
  }

  async getBalance(credentials: AlpacaCredentials): Promise<AccountBalance> {
    const data = await this.request(this.tradingBaseUrl, '/account', { method: 'GET' }, credentials) as Record<string, unknown>
    const cash = Number(data.cash ?? data.buying_power ?? 0)
    const total = Number(data.portfolio_value ?? cash)
    return {
      asset: String(data.currency ?? 'USD'),
      free: cash,
      locked: Math.max(total - cash, 0),
    }
  }

  async getPositions(credentials: AlpacaCredentials): Promise<Position[]> {
    const body = await this.request(this.tradingBaseUrl, '/positions', { method: 'GET' }, credentials)
    if (!Array.isArray(body)) return []
    return body.map((item: Record<string, unknown>) => {
      const qty = Number(item.qty ?? 0)
      return {
        symbol: normalizeUsSymbol(String(item.symbol ?? '')),
        side: qty >= 0 ? 'long' : 'short',
        size: Math.abs(qty),
        entryPrice: Number(item.avg_entry_price ?? 0),
        markPrice: Number(item.current_price ?? 0),
        unrealizedPnl: Number(item.unrealized_pl ?? 0),
        timestamp: Date.now(),
      }
    })
  }

  async listOpenOrders(credentials: AlpacaCredentials, symbol?: string): Promise<Order[]> {
    const symQuery = symbol ? `&symbols=${normalizeUsSymbol(symbol)}` : ''
    const body = await this.request(this.tradingBaseUrl, `/orders?status=open${symQuery}`, { method: 'GET' }, credentials)
    if (!Array.isArray(body)) return []
    return body.map((data: Record<string, unknown>) => {
      const rawStatus = String(data.status ?? 'new').toLowerCase()
      const status = rawStatus === 'partially_filled' ? 'partially_filled' : 'new'
      return {
        id: String(data.id ?? ''),
        symbol: normalizeUsSymbol(String(data.symbol ?? '')),
        side: String(data.side ?? 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy',
        type: String(data.type ?? 'market').toLowerCase() === 'limit' ? 'limit' : 'market',
        status,
        price: data.limit_price !== undefined ? Number(data.limit_price) : undefined,
        quantity: Number(data.qty ?? 0),
        filledQuantity: Number(data.filled_qty ?? 0),
        dryRun: false,
        timestamp: data.created_at ? new Date(String(data.created_at)).getTime() : Date.now(),
      }
    })
  }

  async listTradeFills(credentials: AlpacaCredentials, symbol?: string, limit = 50): Promise<TradeFill[]> {
    const body = await this.request(this.tradingBaseUrl, `/account/activities/FILL?page_size=${Math.min(limit, 100)}`, { method: 'GET' }, credentials)
    if (!Array.isArray(body)) return []
    const sym = symbol ? normalizeUsSymbol(symbol) : undefined
    const fills: TradeFill[] = []
    for (const data of body) {
      const itemSym = normalizeUsSymbol(String(data.symbol ?? ''))
      if (sym && itemSym !== sym) continue
      fills.push({
        id: String(data.id ?? ''),
        symbol: itemSym,
        side: String(data.side ?? 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy',
        price: Number(data.price ?? 0),
        amount: Number(data.qty ?? 0),
        timestamp: data.transaction_time ? new Date(String(data.transaction_time)).getTime() : Date.now(),
      })
    }
    return fills
  }

  async placeOrder(credentials: AlpacaCredentials, req: { symbol: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT'; quantity: number; price?: number }): Promise<Order> {
    const sym = normalizeUsSymbol(req.symbol)
    const body: Record<string, unknown> = {
      symbol: sym,
      qty: String(req.quantity),
      side: req.side.toLowerCase(),
      type: req.type.toLowerCase(),
      time_in_force: 'gtc',
    }
    if (req.type === 'LIMIT' && req.price !== undefined) {
      body.limit_price = String(req.price)
    }
    const data = await this.request(this.tradingBaseUrl, '/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, credentials) as Record<string, unknown>

    return {
      id: String(data.id ?? `alpaca-${Date.now()}`),
      symbol: sym,
      side: req.side.toLowerCase() === 'sell' ? 'sell' : 'buy',
      type: req.type.toLowerCase() === 'limit' ? 'limit' : 'market',
      quantity: req.quantity,
      price: req.price,
      status: (String(data.status ?? 'pending') as any),
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(credentials: AlpacaCredentials, orderId: string): Promise<void> {
    try {
      await this.request(this.tradingBaseUrl, `/orders/${orderId}`, { method: 'DELETE' }, credentials)
    } catch (err) {
      // 幂等：若已终态或未找到则视作成功
      if (err instanceof TradingServiceError && err.code === 'TRADING_UNSUPPORTED_SYMBOL') return
    }
  }

  async getOrder(credentials: AlpacaCredentials, orderId: string): Promise<Order> {
    const data = await this.request(this.tradingBaseUrl, `/orders/${orderId}`, { method: 'GET' }, credentials) as Record<string, unknown>
    const rawStatus = String(data.status ?? 'new').toLowerCase()
    const status = rawStatus === 'filled' ? 'filled'
      : rawStatus === 'canceled' ? 'canceled'
      : rawStatus === 'partially_filled' ? 'partially_filled'
      : 'new'
    return {
      id: String(data.id ?? orderId),
      symbol: normalizeUsSymbol(String(data.symbol ?? '')),
      side: String(data.side ?? 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy',
      type: String(data.type ?? 'market').toLowerCase() === 'limit' ? 'limit' : 'market',
      status,
      price: data.limit_price !== undefined ? Number(data.limit_price) : undefined,
      quantity: Number(data.qty ?? 0),
      filledQuantity: Number(data.filled_qty ?? 0),
      dryRun: false,
      timestamp: data.created_at ? new Date(String(data.created_at)).getTime() : Date.now(),
    }
  }
}

export type { AccountBalance, Interval, Kline, Order, Orderbook, Position, Ticker, TradeFill }
