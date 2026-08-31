/**
 * Futu (富途 OpenD) 连接器插件（dsh-trading hk 切片）：MarketDataService 与 TradeService。
 *
 * @module @dsh-trading/connector-futu
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type {
  AccountBalance,
  Disposable,
  Interval,
  Kline,
  MarketDataService,
  Order,
  OrderRequest,
  Position,
  Ticker,
  TradeService,
} from '@dsh-trading/api'
import {
  type FutuCredentials,
  type FutuRestOptions,
  FutuRestClient,
  INTERVAL_VOCABULARY,
  TradingServiceError,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-hk-connector-futu'

export interface Config {
  enabled: boolean
  gatewayUrl: string
  dryRun: boolean
  liveTrading: boolean
  unlockPwdRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(false),
  gatewayUrl: Schema.string().default('http://127.0.0.1:11111'),
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
  unlockPwdRef: Schema.string().default('FUTU_UNLOCK_PWD'),
})

export const inject = ['tools']

export const TRADING_HK_MARKET_DATA_KEY = 'tradingHkMarketData'
export const TRADING_HK_TRADE_KEY = 'tradingHkTrade'

export class FutuMarketDataService extends Service implements MarketDataService {
  private readonly client: FutuRestClient

  constructor(
    ctx: Context,
    options: FutuRestOptions = {},
    client?: FutuRestClient,
    serviceName: string = TRADING_HK_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = client ?? new FutuRestClient(options)
  }

  getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
  }

  listInstruments(): Promise<Array<{ symbol: string; name?: string }>> {
    return this.client.listInstruments()
  }

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: { intervalMs?: number }): Disposable {
    const ms = Math.max(options?.intervalMs ?? 5_000, 500)
    const tick = (): void => {
      void this.client.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}

export class FutuTradeService extends Service implements TradeService {
  private readonly client: FutuRestClient
  private readonly config: Config

  constructor(
    ctx: Context,
    options: { client: FutuRestClient; config: Config },
    serviceName: string = TRADING_HK_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = options.client
    this.config = options.config
  }

  async getCredentials(): Promise<FutuCredentials> {
    return {
      unlockPwd: (process.env[this.config.unlockPwdRef] ?? ''),
      gatewayUrl: this.config.gatewayUrl,
    }
  }

  async getPositions(): Promise<Position[]> {
    return []
  }

  async getOrders(): Promise<Order[]> {
    return []
  }

  async getBalance(): Promise<AccountBalance> {
    return this.client.getBalance(await this.getCredentials())
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    return this.client.placeOrder(await this.getCredentials(), {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      price: order.price,
    })
  }

  async cancelOrder(orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    return this.client.cancelOrder(await this.getCredentials(), orderId)
  }
}

export interface PlaceOrderArgs {
  readonly symbol: string
  readonly side: 'BUY' | 'SELL'
  readonly type: 'MARKET' | 'LIMIT'
  readonly quantity: number
  readonly price?: number
  readonly dryRun?: boolean
}

export type OrderGateVerdict =
  | { action: 'reject'; code: 'TRADING_LIVE_TRADING_DISABLED'; message: string }
  | { action: 'simulate' }
  | { action: 'live' }

export function evaluateOrderGate(config: Config, args: PlaceOrderArgs): OrderGateVerdict {
  const requestedDryRun = args.dryRun ?? true
  if (!requestedDryRun && !config.liveTrading) {
    return {
      action: 'reject',
      code: 'TRADING_LIVE_TRADING_DISABLED',
      message:
        `hk_place_order rejected: real execution requested (dryRun=${String(args.dryRun)}) `
        + 'but live trading is disabled (liveTrading=false). Enable liveTrading explicitly or keep dryRun=true.',
    }
  }
  if (requestedDryRun || config.dryRun) return { action: 'simulate' }
  return { action: 'live' }
}

export function createPlaceOrderTool(deps: { marketData: Pick<MarketDataService, 'getTicker'>; trade?: TradeService; config: Config }) {
  return defineTool({
    name: 'hk_place_order',
    description: 'Place or simulate a HK stock order via Futu OpenD. dryRun defaults to true for simulated execution.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'HK stock symbol, e.g. 00700.HK' },
      side: { type: 'string', enum: ['BUY', 'SELL'], required: true, description: 'Order side' },
      type: { type: 'string', enum: ['MARKET', 'LIMIT'], required: true, description: 'Order type' },
      quantity: { type: 'number', required: true, description: 'Number of shares (> 0)' },
      price: { type: 'number', description: 'Limit price; required when type=LIMIT' },
      dryRun: { type: 'boolean', default: true, description: 'Simulate order only (default true)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = raw as PlaceOrderArgs
      const verdict = evaluateOrderGate(deps.config, args)
      if (verdict.action === 'reject') {
        return JSON.stringify({ status: 'rejected', code: verdict.code, message: verdict.message })
      }
      if (verdict.action === 'simulate' || !deps.trade) {
        let referencePrice: number | undefined
        try {
          const t = await deps.marketData.getTicker(args.symbol)
          referencePrice = t.price
        } catch {
          // ignore
        }
        return JSON.stringify({
          status: 'filled',
          dryRun: true,
          id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          symbol: args.symbol.toUpperCase(),
          side: args.side.toLowerCase(),
          type: args.type.toLowerCase(),
          quantity: args.quantity,
          ...(args.price ? { price: args.price } : {}),
          referencePrice,
          timestamp: Date.now(),
        })
      }
      const order = await deps.trade.placeOrder({
        symbol: args.symbol,
        side: args.side,
        type: args.type,
        quantity: args.quantity,
        price: args.price,
      })
      return JSON.stringify(order)
    },
  })
}

export const ROUTER_PROVIDER = 'futu'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'hk')) return

  const client = new FutuRestClient({ gatewayUrl: config.gatewayUrl })
  const marketData = new FutuMarketDataService(ctx, { gatewayUrl: config.gatewayUrl }, client)
  const trade = new FutuTradeService(ctx, { client, config })

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'hk_get_ticker',
      description: 'Get the latest trade price and quote for a HK stock via Futu OpenD gateway.',
      parameters: { symbol: { type: 'string', required: true, description: 'HK stock symbol, e.g. 00700.HK' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'hk_get_klines',
      description: 'Get recent public klines for a HK stock via Futu OpenD gateway. Supports 5m/15m/30m/1h/1d/1w/1M.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'HK stock symbol, e.g. 00700.HK' },
        interval: { type: 'string', enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'], default: '1d', description: 'Interval' },
        limit: { type: 'integer', default: 100, description: 'Limit' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const klines = await marketData.getKlines(args.symbol, (args.interval ?? '1d') as Interval, args.limit)
        return JSON.stringify(klines)
      },
    }))

    register(createPlaceOrderTool({ marketData, trade, config }))
  })
}
