/**
 * @dsh-trading/connector-qmt
 * 迅投 MiniQMT A 股券商实盘交易连接器插件。
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
  TradeFill,
  TradeService,
} from '@dsh-trading/api'
import {
  INTERVAL_VOCABULARY,
  QmtRestClient,
  type QmtRestOptions,
  TradingServiceError,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-cn-connector-qmt'

export interface Config {
  enabled: boolean
  env: 'demo' | 'live'
  dryRun: boolean
  liveTrading: boolean
  gatewayUrl?: string
  accountId?: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 QMT 连接器'),
  env: Schema.union(['demo', 'live'] as const).default('demo').description('运行环境'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单'),
  liveTrading: Schema.boolean().default(false).description('是否允许实盘交易'),
  gatewayUrl: Schema.string().default('http://127.0.0.1:5800').description('MiniQMT 本地网关地址'),
  accountId: Schema.string().description('资金账号'),
})

export const TRADING_CN_MARKET_DATA_KEY = 'tradingCnMarketData'
export const TRADING_CN_TRADE_KEY = 'tradingCnTrade'

export class QmtMarketDataService extends Service implements MarketDataService {
  private readonly client: QmtRestClient

  constructor(
    ctx: Context,
    options: QmtRestOptions = {},
    serviceName: string = TRADING_CN_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new QmtRestClient(options)
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

export class QmtTradeService extends Service implements TradeService {
  private readonly client: QmtRestClient
  /** 插件配置（服务缝闸门 P0：dryRun 强制模拟 / liveTrading 总闸门）。 */
  private readonly config: Config

  constructor(
    ctx: Context,
    options: QmtRestOptions & { config: Config },
    serviceName: string = TRADING_CN_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new QmtRestClient(options)
    this.config = options.config
  }

  async getBalance(): Promise<AccountBalance> {
    return this.client.getBalance()
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    // 服务缝闸门（P0 · 铁律 #3 修订版 [S4]）：三态检查下推到服务实现内第一步——
    // 绕过工具层直调本服务（动态包宿主半等）同样 fail-closed；工具层闸门保留（双保险）。
    const requestedDryRun = order.dryRun ?? true
    if (!requestedDryRun && !this.config.liveTrading) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        `QMT TradeService.placeOrder rejected: the request asks for real execution (dryRun=${String(order.dryRun)}) `
          + 'but liveTrading=false — enable liveTrading explicitly or keep dryRun=true for a simulated fill.',
      )
    }
    if (requestedDryRun || this.config.dryRun) {
      // 闸门 ②：本地模拟回执（工具层另有带市价参照的富回执）。
      return {
        id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        status: 'filled',
        ...(order.price !== undefined ? { price: order.price } : {}),
        quantity: order.quantity,
        dryRun: true,
        timestamp: Date.now(),
      }
    }
    // 闸门 ③：live（dryRun=false 且 liveTrading=true）→ 真实下单。
    return this.client.placeOrder(undefined, order)
  }

  async cancelOrder(orderId: string, _symbol?: string): Promise<void> {
    // 服务缝闸门（P0）：撤单是会改变交易所/券商真实状态的实盘动作，与真实下单同门槛
    // （liveTrading 显式开启且未强制模拟），防「经撤单接口绕过下单闸门」。
    if (!this.config.liveTrading || this.config.dryRun) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        'QMT TradeService.cancelOrder rejected at the service seam: cancel is a live action and requires liveTrading=true with dryRun=false.',
      )
    }
    return this.client.cancelOrder(undefined, orderId) as unknown as void
  }

  async getPositions(): Promise<Position[]> {
    return this.client.getPositions()
  }

  async getBalances(): Promise<AccountBalance[]> {
    try {
      const b = await this.client.getBalance()
      return [b]
    } catch {
      return []
    }
  }

  async listOpenOrders(_symbol?: string): Promise<Order[]> {
    return []
  }

  async listTradeFills(_symbol?: string, _limit?: number): Promise<TradeFill[]> {
    return []
  }

  async getOrder(symbol: string, id: string): Promise<Order> {
    return {
      id,
      symbol,
      side: 'buy',
      type: 'limit',
      status: 'new',
      quantity: 0,
      dryRun: false,
      timestamp: Date.now(),
    }
  }
}

export const ROUTER_PROVIDER = 'qmt'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'cn')) return

  const marketData = new QmtMarketDataService(ctx, { gatewayUrl: config.gatewayUrl, accountId: config.accountId })
  const trade = new QmtTradeService(ctx, { gatewayUrl: config.gatewayUrl, accountId: config.accountId , config })

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'cn_get_ticker',
      description: 'Get the latest trade price and quote for an A-share stock via MiniQMT.',
      parameters: { symbol: { type: 'string', required: true, description: 'A-share stock symbol, e.g. 600519.SH' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'cn_get_klines',
      description: 'Get recent public klines for an A-share stock via MiniQMT.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'A-share stock symbol, e.g. 600519.SH' },
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
      name: 'cn_place_order',
      description: 'Place or simulate an A-share order via MiniQMT gateway.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'A-share symbol, e.g. 600519.SH' },
        side: { type: 'string', enum: ['buy', 'sell'], required: true, description: 'Side' },
        type: { type: 'string', enum: ['market', 'limit'], required: true, description: 'Type' },
        quantity: { type: 'number', required: true, description: 'Quantity (shares, e.g. 100)' },
        price: { type: 'number', description: 'Limit price' },
        dryRun: { type: 'boolean', default: true, description: 'Dry run' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        if (args.dryRun !== false) {
          let refPrice = args.price
          if (!refPrice || refPrice <= 0) {
            try {
              const t = await marketData.getTicker(args.symbol)
              refPrice = t.price
            } catch {
              refPrice = 0
            }
          }
          return JSON.stringify({
            id: `sim-qmt-${Date.now()}`,
            symbol: toQmtCode(args.symbol),
            side: args.side,
            type: args.type,
            status: 'filled',
            quantity: args.quantity,
            price: refPrice ?? 0,
            dryRun: true,
            timestamp: Date.now(),
          })
        }
        if (!config.liveTrading) {
          return JSON.stringify({
            status: 'rejected',
            code: 'TRADING_LIVE_TRADING_DISABLED',
            message: 'Live trading is disabled on QMT plugin.',
          })
        }
        const order = await trade.placeOrder({
          symbol: args.symbol,
          side: args.side as 'buy' | 'sell',
          type: args.type as 'market' | 'limit',
          quantity: args.quantity,
          price: args.price,
          dryRun: false,
        })
        return JSON.stringify(order)
      },
    }))

    register(defineTool({
      name: 'cn_cancel_order',
      description: 'Cancel an A-share order on QMT by order ID.',
      parameters: { ordId: { type: 'string', required: true, description: 'Order ID' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const res = await trade.cancelOrder(args.ordId)
        return JSON.stringify(res)
      },
    }))

    register(defineTool({
      name: 'cn_get_balance',
      description: 'Get A-share account balance via QMT.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        const bal = await trade.getBalance()
        return JSON.stringify(bal)
      },
    }))
  })
}
