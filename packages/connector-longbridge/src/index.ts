/**
 * @dsh-trading/connector-longbridge
 * 长桥 (Longbridge) 港股连接器插件（提供 tradingHkMarketData 与 hk_* 工具）。
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
  LongbridgeRestClient,
  type LongbridgeRestOptions,
  INTERVAL_VOCABULARY,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-hk-connector-longbridge'

export interface Config {
  enabled: boolean
  env: 'demo' | 'live'
  dryRun: boolean
  liveTrading: boolean
  appKeyRef: string
  appSecretRef: string
  accessTokenRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 Longbridge 连接器'),
  env: Schema.union(['demo', 'live'] as const).default('demo').description('运行环境'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单'),
  liveTrading: Schema.boolean().default(false).description('是否允许实盘交易'),
  appKeyRef: Schema.string().default('LONGBRIDGE_APP_KEY').description('Longbridge App Key 环境变量名 (BYOK)'),
  appSecretRef: Schema.string().default('LONGBRIDGE_APP_SECRET').description('Longbridge App Secret 环境变量名'),
  accessTokenRef: Schema.string().default('LONGBRIDGE_ACCESS_TOKEN').description('Longbridge Access Token 环境变量名'),
})

export const TRADING_HK_MARKET_DATA_KEY = 'tradingHkMarketData'
export const TRADING_HK_TRADE_KEY = 'tradingHkTrade'

export class LongbridgeMarketDataService extends Service implements MarketDataService {
  private readonly client: LongbridgeRestClient

  constructor(
    ctx: Context,
    options: LongbridgeRestOptions = {},
    serviceName: string = TRADING_HK_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new LongbridgeRestClient(options)
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

export class LongbridgeTradeService extends Service implements TradeService {
  private readonly client: LongbridgeRestClient

  constructor(
    ctx: Context,
    options: LongbridgeRestOptions = {},
    serviceName: string = TRADING_HK_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new LongbridgeRestClient(options)
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

export const ROUTER_PROVIDER = 'longbridge'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'hk')) return

  const appKey = process.env[config.appKeyRef]
  const appSecret = process.env[config.appSecretRef]
  const accessToken = process.env[config.accessTokenRef]
  const marketData = new LongbridgeMarketDataService(ctx, { appKey, appSecret, accessToken })
  const trade = new LongbridgeTradeService(ctx, { appKey, appSecret, accessToken })

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'hk_get_ticker',
      description: 'Get the latest trade price and quote for a HK stock via Longbridge API.',
      parameters: { symbol: { type: 'string', required: true, description: 'HK stock symbol, e.g. 00700.HK' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'hk_get_klines',
      description: 'Get recent public klines for a HK stock via Longbridge API. Supports 1m/5m/15m/30m/1h/1d/1w/1M.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'HK stock symbol, e.g. 00700.HK' },
        interval: { type: 'string', enum: INTERVAL_VOCABULARY, default: '1d', description: 'Interval' },
        limit: { type: 'integer', default: 100, description: 'Limit' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const klines = await marketData.getKlines(args.symbol, (args.interval ?? '1d') as Interval, args.limit)
        return JSON.stringify(klines)
      },
    }))
  })
}
