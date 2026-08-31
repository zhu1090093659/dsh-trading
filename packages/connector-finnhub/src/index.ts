/**
 * @dsh-trading/connector-finnhub
 * Finnhub 美股连接器插件（提供 tradingUsMarketData 与 us_* 行情/新闻工具）。
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
  FinnhubRestClient,
  type FinnhubRestOptions,
  INTERVAL_VOCABULARY,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-us-connector-finnhub'

export interface Config {
  enabled: boolean
  env: 'demo' | 'live'
  dryRun: boolean
  liveTrading: boolean
  apiKeyRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 Finnhub 连接器'),
  env: Schema.union(['demo', 'live'] as const).default('demo').description('运行环境'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单'),
  liveTrading: Schema.boolean().default(false).description('是否允许实盘交易'),
  apiKeyRef: Schema.string().default('FINNHUB_API_KEY').description('Finnhub API Key 环境变量名 (BYOK)'),
})

export const TRADING_US_MARKET_DATA_KEY = 'tradingUsMarketData'
export const TRADING_US_TRADE_KEY = 'tradingUsTrade'

export class FinnhubMarketDataService extends Service implements MarketDataService {
  private readonly client: FinnhubRestClient

  constructor(
    ctx: Context,
    options: FinnhubRestOptions = {},
    serviceName: string = TRADING_US_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new FinnhubRestClient(options)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
  }

  async getNews(symbol: string): Promise<Array<Record<string, unknown>>> {
    return this.client.getNews(symbol)
  }

  async listInstruments(query?: string): Promise<Array<{ symbol: string; name: string }>> {
    return this.client.listInstruments(query)
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

export class FinnhubTradeService extends Service implements TradeService {
  private readonly client: FinnhubRestClient

  constructor(
    ctx: Context,
    options: FinnhubRestOptions = {},
    serviceName: string = TRADING_US_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new FinnhubRestClient(options)
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

export const ROUTER_PROVIDER = 'finnhub'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'us')) return

  const apiKey = process.env[config.apiKeyRef]
  const marketData = new FinnhubMarketDataService(ctx, { apiKey })
  const trade = new FinnhubTradeService(ctx, { apiKey })

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'us_get_ticker',
      description: 'Get the latest trade price and quote for a US stock via Finnhub API.',
      parameters: { symbol: { type: 'string', required: true, description: 'US stock symbol, e.g. AAPL' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'us_get_klines',
      description: 'Get recent public klines for a US stock via Finnhub API. Supports 1m/5m/15m/30m/1h/1d/1w/1M.',
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
      name: 'us_get_news',
      description: 'Get recent company news and market headlines for a US stock via Finnhub.',
      parameters: { symbol: { type: 'string', required: true, description: 'US stock symbol, e.g. AAPL' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const news = await marketData.getNews(args.symbol)
        return JSON.stringify(news)
      },
    }))
  })
}
