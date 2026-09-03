/**
 * @dshtrading/connector-ibkr/rest
 * Interactive Brokers (盈透证券) Client Portal Gateway REST 客户端。
 */

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

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'] as const

export function normalizeUsSymbol(raw: string): string {
  const clean = raw.trim().toUpperCase()
  if (!clean) throw new TradingServiceError('TRADING_INVALID_ARGUMENT', 'Symbol cannot be empty')
  return clean
}

export interface IbkrRestOptions {
  gatewayUrl?: string
  accountId?: string
  fetchImpl?: typeof fetch
}

export class IbkrRestClient {
  readonly gatewayUrl: string
  readonly accountId?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: IbkrRestOptions = {}) {
    this.gatewayUrl = options.gatewayUrl ?? (process.env.IBKR_GATEWAY_URL || 'https://127.0.0.1:5000/v1/api')
    this.accountId = options.accountId ?? process.env.IBKR_ACCOUNT_ID
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.gatewayUrl}${path}`
    try {
      const res = await this.fetchImpl(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `IBKR HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `IBKR network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const sym = normalizeUsSymbol(symbol)
    try {
      const data = await this.requestJson<Array<{ conid?: number; 31?: string; 84?: string; 86?: string }>>(
        `/iserver/marketdata/snapshot?symbols=${encodeURIComponent(sym)}&fields=31,84,86`,
      )
      if (Array.isArray(data) && data.length > 0) {
        const row = data[0]
        const price = parseFloat(row['31'] || '0')
        return {
          symbol: sym,
          price,
          timestamp: Date.now(),
        }
      }
    } catch {
      // 离线/未连接网关时回退公共源
      const res = await this.fetchImpl(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`)
      const d = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } }
      const price = d.chart?.result?.[0]?.meta?.regularMarketPrice ?? 0
      return {
        symbol: sym,
        price,
        timestamp: Date.now(),
      }
    }

    return { symbol: sym, price: 0, timestamp: Date.now() }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const sym = normalizeUsSymbol(symbol)
    try {
      const data = await this.requestJson<{ data?: Array<{ t: number; o: number; c: number; h: number; l: number; v: number }> }>(
        `/hmds/history?symbol=${sym}&period=${limit}d&bar=${interval}`,
      )
      if (Array.isArray(data.data)) {
        return data.data.map((r) => ({
          openTime: r.t,
          open: r.o,
          high: r.h,
          low: r.l,
          close: r.c,
          volume: r.v,
          closeTime: r.t + 86400000 - 1,
        }))
      }
    } catch {
      // 回退公共源
      const res = await this.fetchImpl(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=1mo`)
      const d = await res.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open: number[]; close: number[]; high: number[]; low: number[]; volume: number[] }> } }> } }
      const res0 = d.chart?.result?.[0]
      if (!res0?.timestamp || !res0.indicators?.quote?.[0]) return []
      const q = res0.indicators.quote[0]
      return res0.timestamp.slice(-limit).map((t, idx) => ({
        openTime: t * 1000,
        open: q.open[idx] ?? 0,
        high: q.high[idx] ?? 0,
        low: q.low[idx] ?? 0,
        close: q.close[idx] ?? 0,
        volume: q.volume[idx] ?? 0,
        closeTime: (t + 86400) * 1000 - 1,
      }))
    }

    return []
  }

  async getBalance(accountId?: string): Promise<AccountBalance> {
    const acc = accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'IBKR: accountId is required to query balance')
    }
    const res = await this.requestJson<Record<string, { cashbalance?: number; netliquidationvalue?: number; currency?: string }>>(
      `/portfolio/${encodeURIComponent(acc)}/ledger`,
    )

    const base = res.USD ?? res.BASE ?? Object.values(res)[0]
    if (!base) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'IBKR getBalance: empty ledger returned')
    }

    return {
      currency: base.currency ?? 'USD',
      available: base.cashbalance ?? 0,
      total: base.netliquidationvalue ?? base.cashbalance ?? 0,
    }
  }

  async getPositions(accountId?: string): Promise<Position[]> {
    const acc = accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'IBKR: accountId is required to query positions')
    }
    const res = await this.requestJson<Array<{
      ticker?: string
      contractDesc?: string
      position?: number
      mktPrice?: number
      avgPrice?: number
      unrealizedPnl?: number
    }>>(`/portfolio/${encodeURIComponent(acc)}/positions/0`)

    if (!Array.isArray(res)) return []
    return res.map((p) => ({
      symbol: normalizeUsSymbol(p.ticker ?? p.contractDesc ?? ''),
      quantity: p.position ?? 0,
      entryPrice: p.avgPrice ?? 0,
      unrealizedPnl: p.unrealizedPnl ?? 0,
    }))
  }

  async placeOrder(creds: { accountId?: string } | undefined, req: OrderRequest): Promise<Order> {
    const acc = creds?.accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'IBKR: accountId is required to place order')
    }
    const sym = normalizeUsSymbol(req.symbol)
    let res = await this.requestJson<Array<{ order_id?: string; order_status?: string; id?: string; message?: string[] }>>(
      `/iserver/account/${encodeURIComponent(acc)}/orders`,
      {
        method: 'POST',
        body: JSON.stringify({
          orders: [
            {
              acctId: acc,
              secType: 'STK',
              ticker: sym,
              orderType: req.type === 'market' ? 'MKT' : 'LMT',
              side: req.side.toUpperCase(),
              quantity: req.quantity,
              price: req.price,
              tif: 'DAY',
            },
          ],
        }),
      },
    )

    if (!Array.isArray(res) || res.length === 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'IBKR placeOrder: empty response from gateway')
    }

    // 处理 IBKR Pre-order Warning 确认提示
    if (res[0].id && !res[0].order_id) {
      const replyId = res[0].id
      res = await this.requestJson<Array<{ order_id?: string; order_status?: string }>>(
        `/iserver/reply/${encodeURIComponent(replyId)}`,
        {
          method: 'POST',
          body: JSON.stringify({ confirmed: true }),
        },
      )
    }

    const first = res[0]
    const orderId = first?.order_id ?? `ibkr-${Date.now()}`

    return {
      id: String(orderId),
      symbol: sym,
      side: req.side,
      type: req.type,
      status: (first?.order_status?.toLowerCase() as Order['status']) ?? 'new',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(creds: { accountId?: string } | undefined, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    const acc = creds?.accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'IBKR: accountId is required to cancel order')
    }
    await this.requestJson(`/iserver/account/${encodeURIComponent(acc)}/order/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
    })
    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }
