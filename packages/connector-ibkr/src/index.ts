/**
 * @dsh-trading/connector-ibkr
 * Interactive Brokers (盈透证券) 美股/全球连接器插件。
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
  IbkrRestClient,
  type IbkrRestOptions,
  INTERVAL_VOCABULARY,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-us-connector-ibkr'

export interface Config {
  enabled: boolean
  env: 'demo' | 'live'
  dryRun: boolean
  liveTrading: boolean
  gatewayUrl?: string
  accountId?: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 IBKR 连接器'),
  env: Schema.union(['demo', 'live'] as const).default('demo').description('运行环境'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单'),
  liveTrading: Schema.boolean().default(false).description('是否允许实盘交易'),
  gatewayUrl: Schema.string().default('https://127.0.0.1:5000/v1/api').description('IBKR Client Portal 网关地址'),
  accountId: Schema.string().description('IBKR 账户 ID'),
})

export const TRADING_US_MARKET_DATA_KEY = 'tradingUsMarketData'
export const TRADING_US_TRADE_KEY = 'tradingUsTrade'

export class IbkrMarketDataService extends Service implements MarketDataService {
  private readonly client: IbkrRestClient

  constructor(
    ctx: Context,
    options: IbkrRestOptions = {},
    serviceName: string = TRADING_US_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new IbkrRestClient(options)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
  }

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: { intervalMs?: number }): Disposable {
    const ms = Math.max(options?.intervalMs ?? 5_000, 1_000)
    const tick = (): void => {
      void this.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}

export class IbkrTradeService extends Service implements TradeService {
  private readonly client: IbkrRestClient

  constructor(
    ctx: Context,
    options: IbkrRestOptions = {},
    serviceName: string = TRADING_US_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new IbkrRestClient(options)
  }

  async getBalance(): Promise<AccountBalance> {
    return this.client.getBalance()
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    return this.client.placeOrder(undefined, order)
  }

  async cancelOrder(orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    return this.client.cancelOrder(undefined, orderId)
  }

  async getPositions(): Promise<Position[]> {
    return []
  }

  async getOrders(): Promise<Order[]> {
    return []
  }
}

export const ROUTER_PROVIDER = 'ibkr'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'us')) return

  const marketData = new IbkrMarketDataService(ctx, { gatewayUrl: config.gatewayUrl, accountId: config.accountId })
  const trade = new IbkrTradeService(ctx, { gatewayUrl: config.gatewayUrl, accountId: config.accountId })

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'us_get_ticker',
      description: 'Get the latest trade price and quote for a US stock via IBKR.',
      parameters: { symbol: { type: 'string', required: true, description: 'US stock symbol, e.g. AAPL' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'us_get_klines',
      description: 'Get recent public klines for a US stock via IBKR.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'US stock symbol, e.g. AAPL' },
        interval: { type: 'string', enum: INTERVAL_VOCABULARY, default: '1d', description: 'Interval' },
        limit: { type: 'integer', default: 100, description: 'Limit' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const klines = await marketData.getKlines(args.symbol, (args.interval ?? '1d') as Interval, args.limit)
        return JSON.stringify(klines)
      },
    }))

    register(defineTool({
      name: 'us_place_order',
      description: 'Place or simulate a US stock order via Interactive Brokers.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'US symbol, e.g. AAPL' },
        side: { type: 'string', enum: ['buy', 'sell'], required: true, description: 'Side' },
        type: { type: 'string', enum: ['market', 'limit'], required: true, description: 'Type' },
        quantity: { type: 'number', required: true, description: 'Quantity' },
        price: { type: 'number', description: 'Price' },
        dryRun: { type: 'boolean', default: true, description: 'Dry run' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        if (!config.liveTrading && args.dryRun === false) {
          return JSON.stringify({
            status: 'rejected',
            code: 'TRADING_LIVE_TRADING_DISABLED',
            message: 'Live trading is disabled on IBKR plugin.',
          })
        }
        const order = await trade.placeOrder({
          symbol: args.symbol,
          side: args.side as 'buy' | 'sell',
          type: args.type as 'market' | 'limit',
          quantity: args.quantity,
          price: args.price,
          dryRun: args.dryRun ?? true,
        })
        return JSON.stringify(order)
      },
    }))

    register(defineTool({
      name: 'us_cancel_order',
      description: 'Cancel a US stock order on IBKR by order ID.',
      parameters: { ordId: { type: 'string', required: true, description: 'Order ID' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const res = await trade.cancelOrder(args.ordId)
        return JSON.stringify(res)
      },
    }))

    register(defineTool({
      name: 'us_get_balance',
      description: 'Get US account balance and purchasing power via IBKR.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        const bal = await trade.getBalance()
        return JSON.stringify(bal)
      },
    }))
  })
}
