/**
 * Futu (富途 OpenD) 连接器插件（dsh-trading hk 切片）：MarketDataService 与 TradeService。
 *
 * @module @dshtrading/connector-futu
 */

import { liveTradingEnabled } from '@dshtrading/authority'
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
} from '@dshtrading/api'
import {
  type FutuCredentials,
  type FutuPendingOrder,
  type FutuRestOptions,
  FutuRestClient,
  INTERVAL_VOCABULARY,
  normalizeSymbol,
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
  /** OpenD 账户 id（accId）。0 = 用 OpenD 的默认账户；**撤单必须显式给**（见 cancelOrder）。 */
  accId: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(false),
  gatewayUrl: Schema.string().default('http://127.0.0.1:11111'),
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
  unlockPwdRef: Schema.string().default('FUTU_UNLOCK_PWD'),
  accId: Schema.number().default(0),
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

/** OpenD 回报的市价类订单类型（`place_order` 入参写 NORMAL/MARKET，挂单列表回它自己的枚举）。 */
const MARKET_ORDER_TYPES = new Set(['MARKET', 'MARKET_IF_TOUCHED'])

/** 其余都按限价/条件类处理：成交语义都是"带价挂出"。 */
const LIMIT_ORDER_TYPES = new Set([
  'NORMAL', 'ABSOLUTE_LIMIT', 'SPECIAL_LIMIT', 'SPECIAL_LIMIT_ALL', 'AUCTION', 'AUCTION_LIMIT',
  'LIMIT_IF_TOUCHED', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP', 'TRAILING_STOP_LIMIT',
  'TWAP', 'TWAP_LIMIT', 'VWAP', 'VWAP_LIMIT',
])

/** OpenD 挂单状态串 → api 的状态词汇。**认不出即抛**（不猜成 new，也不猜成终态）。 */
export function orderStatusOf(venueStatus: string): Order['status'] {
  switch (venueStatus.trim().toUpperCase()) {
    case 'SUBMITTED':
    case 'SUBMITTING':
    case 'WAITING_SUBMIT':
    case 'UNSUBMITTED':
    case 'CANCELLING_ALL':
    case 'CANCELLING_PART':
      return 'new'
    case 'FILLED_PART':
      return 'partially_filled'
    case 'FILLED_ALL':
      return 'filled'
    case 'CANCELLED_ALL':
    case 'CANCELLED_PART':
    case 'FILL_CANCELLED':
    case 'DELETED':
    case 'DISABLED':
      return 'canceled'
    case 'FAILED':
    case 'SUBMIT_FAILED':
      return 'rejected'
    case 'TIMEOUT':
      return 'expired'
    default:
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Futu: 认不出的挂单状态 ${JSON.stringify(venueStatus)}`)
  }
}

/** OpenD 订单类型串 → limit / market。**认不出即抛**。 */
export function orderTypeOf(venueType: string): Order['type'] {
  const upper = venueType.trim().toUpperCase()
  if (MARKET_ORDER_TYPES.has(upper)) return 'market'
  if (LIMIT_ORDER_TYPES.has(upper)) return 'limit'
  throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Futu: 认不出的订单类型 ${JSON.stringify(venueType)}`)
}

/**
 * 挂单行 → api `Order`。
 *
 * `dryRun: false`：这是 venue 侧真存在的单子（不是本地模拟回执）。时间戳取 venue 的
 * `createTime`（桥已转成 ISO UTC）；认不出就抛，**不用读表时刻顶替**（顶替会让"这单什么时候挂的"
 * 变成一句假话）。`qty` 同理：桥没给就抛，**不折成 0**（0 会让"挂了多少股"变成另一句假话）。
 */
export function toOrder(row: FutuPendingOrder): Order {
  const side = row.trdSide?.trim().toUpperCase()
  if (side !== 'BUY' && side !== 'SELL') {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR',
      `Futu: 挂单 ${row.orderId} 的方向认不出（${JSON.stringify(row.trdSide)}）`)
  }
  const createdMs = row.createTime === undefined ? Number.NaN : Date.parse(row.createTime)
  if (!Number.isFinite(createdMs)) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR',
      `Futu: 挂单 ${row.orderId} 的 createTime 认不出（${JSON.stringify(row.createTime)}）`)
  }
  // 数量缺了就抛：历史的 `row.qty ?? 0` 会把"挂了多少股"静默变成 0 —— 挂单行是对账的输入，
  // 一句假数量比一句报错更坏（与 createTime／方向／类型同一条口径：认不出即抛）。
  if (row.qty === undefined) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR',
      `Futu: 挂单 ${row.orderId} 缺 qty（${JSON.stringify(row.qty)}）——挂了多少股不许折成 0`)
  }
  return {
    id: row.orderId,
    symbol: normalizeSymbol(row.code),
    side: side === 'BUY' ? 'buy' : 'sell',
    type: orderTypeOf(row.orderType ?? ''),
    status: orderStatusOf(row.orderStatus),
    ...(row.price !== undefined ? { price: row.price } : {}),
    quantity: row.qty,
    ...(row.dealtQty !== undefined ? { filledQuantity: row.dealtQty } : {}),
    dryRun: false,
    timestamp: createdMs,
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
      // 交易环境由**同一道实盘闸门**决定：闸门不放行就只在 OpenD 的 SIMULATE 环境里动
      // （没有默认实盘；镜像配置本身不是授权，判定归 @dshtrading/authority）。
      trdEnv: liveTradingEnabled(this.config.liveTrading) ? 'REAL' : 'SIMULATE',
      accId: this.config.accId,
    }
  }

  async getPositions(): Promise<Position[]> {
    return []
  }

  /** 挂单列表（桥的 `/api/trd/get-orders`）。`symbol` 给定时按标的过滤。 */
  async listOpenOrders(symbol?: string): Promise<Order[]> {
    const rows = await this.client.getPendingOrders(await this.getCredentials())
    const orders = rows.map(toOrder)
    if (symbol === undefined) return orders
    const wanted = normalizeSymbol(symbol)
    return orders.filter((order) => order.symbol === wanted)
  }

  async getOrders(): Promise<Order[]> {
    return this.listOpenOrders()
  }

  async getBalance(): Promise<AccountBalance> {
    return this.client.getBalance(await this.getCredentials())
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    // 服务缝闸门（P0 · 铁律 #3 修订版 [S4]）：三态检查下推到服务实现内第一步——
    // 绕过工具层直调本服务（动态包宿主半等）同样 fail-closed；工具层闸门保留（双保险）。
    const requestedDryRun = order.dryRun ?? true
    if (!requestedDryRun && !liveTradingEnabled(this.config.liveTrading)) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        `Futu TradeService.placeOrder rejected: the request asks for real execution (dryRun=${String(order.dryRun)}) `
          + 'but the signed live-trading authority does not grant real execution (see @dshtrading/authority) — keep dryRun=true for a simulated fill.',
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
    // 闸门 ③：live（dryRun=false 且实盘已获授权）→ 真实下单。
    return this.client.placeOrder(await this.getCredentials(), {
      symbol: order.symbol,
      side: order.side.toUpperCase() as 'BUY' | 'SELL',
      type: order.type.toUpperCase() as 'MARKET' | 'LIMIT',
      quantity: order.quantity,
      price: order.price,
    })
  }

  async cancelOrder(orderId: string, _symbol?: string): Promise<void> {
    // 服务缝闸门（P0）：撤单是会改变券商真实状态的实盘动作，与真实下单同门槛。
    if (!liveTradingEnabled(this.config.liveTrading) || this.config.dryRun) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        'Futu TradeService.cancelOrder rejected at the service seam: cancel is a live action and requires a signed live-trading grant (see @dshtrading/authority) with dryRun=false.',
      )
    }
    return this.client.cancelOrder(await this.getCredentials(), orderId) as unknown as void
  }

  async getBalances(): Promise<AccountBalance[]> {
    try {
      const b = await this.client.getBalance(await this.getCredentials())
      return [b]
    } catch {
      return []
    }
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
  if (!requestedDryRun && !liveTradingEnabled(config.liveTrading)) {
    return {
      action: 'reject',
      code: 'TRADING_LIVE_TRADING_DISABLED',
      message:
        `hk_place_order rejected: real execution requested (dryRun=${String(args.dryRun)}) `
        + 'but live trading is disabled (no signed live-trading grant from the authority plane). Ask the operator to sign a live-trading grant, or keep dryRun=true.',
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
        side: args.side === 'SELL' ? 'sell' : 'buy',
        type: args.type === 'LIMIT' ? 'limit' : 'market',
        quantity: args.quantity,
        price: args.price,
        dryRun: false,
      })
      return JSON.stringify(order)
    },
  })
}

export const ROUTER_PROVIDER = 'futu'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'hk')) return

  const client = new FutuRestClient({ gatewayUrl: config.gatewayUrl, market: 'hk' })
  const marketData = new FutuMarketDataService(ctx, { gatewayUrl: config.gatewayUrl, market: 'hk' }, client)
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

    register(createPlaceOrderTool({ marketData, trade: trade as unknown as TradeService, config }))
  })
}
