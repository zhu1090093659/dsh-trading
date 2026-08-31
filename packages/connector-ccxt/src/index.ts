/**
 * @dsh-trading/connector-ccxt
 * CCXT 跨所加密通用连接器插件（提供 tradingCryptoMarketData 与多所聚合工具）。
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
  CcxtRestClient,
  type CcxtRestOptions,
  INTERVAL_VOCABULARY,
  SUPPORTED_EXCHANGES,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-crypto-connector-ccxt'

export interface Config {
  enabled: boolean
  env: 'demo' | 'live'
  dryRun: boolean
  liveTrading: boolean
  defaultExchange: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 CCXT 连接器'),
  env: Schema.union(['demo', 'live'] as const).default('demo').description('运行环境'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单'),
  liveTrading: Schema.boolean().default(false).description('是否允许实盘交易'),
  defaultExchange: Schema.string().default('binance').description('默认首选交易所'),
})

export const TRADING_CRYPTO_MARKET_DATA_KEY = 'tradingCryptoMarketData'
export const TRADING_CRYPTO_TRADE_KEY = 'tradingCryptoTrade'

export class CcxtMarketDataService extends Service implements MarketDataService {
  private readonly client: CcxtRestClient

  constructor(
    ctx: Context,
    options: CcxtRestOptions = {},
    serviceName: string = TRADING_CRYPTO_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new CcxtRestClient(options)
  }

  async getTicker(symbol: string, exchange?: string): Promise<Ticker> {
    return this.client.getTicker(symbol, exchange)
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100, exchange?: string): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit, exchange)
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

export class CcxtTradeService extends Service implements TradeService {
  private readonly client: CcxtRestClient

  constructor(
    ctx: Context,
    options: CcxtRestOptions = {},
    serviceName: string = TRADING_CRYPTO_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new CcxtRestClient(options)
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

export const ROUTER_PROVIDER = 'ccxt'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'crypto')) return

  const marketData = new CcxtMarketDataService(ctx, { exchange: config.defaultExchange })
  const trade = new CcxtTradeService(ctx, { exchange: config.defaultExchange })

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'crypto_get_ticker',
      description: 'Get the latest ticker quote for any crypto pair across 100+ exchanges via CCXT.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'Crypto pair symbol, e.g. BTCUSDT or BTC/USDT' },
        exchange: { type: 'string', enum: SUPPORTED_EXCHANGES, default: 'binance', description: 'Exchange slug' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol, args.exchange))
      },
    }))

    register(defineTool({
      name: 'crypto_get_klines',
      description: 'Get recent klines for any crypto pair via CCXT.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'Crypto pair symbol, e.g. BTCUSDT' },
        interval: { type: 'string', enum: INTERVAL_VOCABULARY, default: '1d', description: 'Interval' },
        limit: { type: 'integer', default: 100, description: 'Limit' },
        exchange: { type: 'string', enum: SUPPORTED_EXCHANGES, default: 'binance', description: 'Exchange slug' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const klines = await marketData.getKlines(args.symbol, (args.interval ?? '1d') as Interval, args.limit, args.exchange)
        return JSON.stringify(klines)
      },
    }))
  })
}
