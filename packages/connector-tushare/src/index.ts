/**
 * @dshtrading/connector-tushare
 * Tushare Pro A 股量化连接器插件（提供 tradingCnMarketData 与 cn_* 分析工具）。
 */

import { liveTradingEnabled } from '@dshtrading/authority'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type {
  Disposable,
  Interval,
  Kline,
  MarketDataService,
  Order,
  OrderRequest,
  Position,
  Ticker,
  TradeService,
} from '@dshtrading/api'
import {
  TushareRestClient,
  type TushareRestOptions,
  INTERVAL_VOCABULARY,
  TradingServiceError,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-cn-connector-tushare'

export interface Config {
  enabled: boolean
  dryRun: boolean
  liveTrading: boolean
  tokenRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 Tushare 连接器'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单'),
  liveTrading: Schema.boolean().default(false).description('是否允许实盘交易'),
  tokenRef: Schema.string().default('TUSHARE_TOKEN').description('Tushare Pro Token 环境变量名 (BYOK)'),
})

export const TRADING_CN_MARKET_DATA_KEY = 'tradingCnMarketData'
export const TRADING_CN_TRADE_KEY = 'tradingCnTrade'

export class TushareMarketDataService extends Service implements MarketDataService {
  private readonly client: TushareRestClient

  constructor(
    ctx: Context,
    options: TushareRestOptions = {},
    serviceName: string = TRADING_CN_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new TushareRestClient(options)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
  }

  async getDailyBasic(symbol: string): Promise<Record<string, unknown>> {
    return this.client.getDailyBasic(symbol)
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

export class TushareTradeService extends Service implements TradeService {
  private readonly client: TushareRestClient
  /** 插件配置（服务缝闸门 P0：dryRun 强制模拟 / liveTrading 非权威镜像——实盘授权由 @dshtrading/authority 的人工签署平面裁定）。 */
  private readonly config: Config

  constructor(
    ctx: Context,
    options: TushareRestOptions & { config: Config },
    serviceName: string = TRADING_CN_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new TushareRestClient(options)
    this.config = options.config
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    // 服务缝闸门（P0 · 铁律 #3 修订版 [S4]）：三态检查下推到服务实现内第一步——
    // 绕过工具层直调本服务（动态包宿主半等）同样 fail-closed；工具层闸门保留（双保险）。
    const requestedDryRun = order.dryRun ?? true
    if (!requestedDryRun && !liveTradingEnabled(this.config.liveTrading)) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        `Tushare TradeService.placeOrder rejected: the request asks for real execution (dryRun=${String(order.dryRun)}) `
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
    return this.client.placeOrder(undefined, order)
  }

  async cancelOrder(orderId: string, _symbol?: string): Promise<void> {
    // 服务缝闸门（P0）：撤单是会改变交易所/券商真实状态的实盘动作，与真实下单同门槛
    // （授权平面已授予且未强制模拟），防「经撤单接口绕过下单闸门」。
    if (!liveTradingEnabled(this.config.liveTrading) || this.config.dryRun) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        'Tushare TradeService.cancelOrder rejected at the service seam: cancel is a live action and requires a signed live-trading grant (see @dshtrading/authority) with dryRun=false.',
      )
    }
    return this.client.cancelOrder(undefined, orderId) as unknown as void
  }

  /**
   * 账户读面不可用（Tushare 是行情数据服务，本连接器从来没有账户通道）：
   * 必需方法必须显式拒绝。base 的账户工具与 GUI 桥把同一注册面当「账户真值」消费——
   * 返回常量余额、空数组或编造订单会被读成「余额充足」「没有持仓」「订单存在」，
   * 而契约语义是 TRADING_NOT_IMPLEMENTED（不可用）。rest 层的 `placeOrder` /
   * `cancelOrder` 只是本地合成回执，不构成账户通道；非契约方法 getBalance / getOrders
   * 直接缺席，由消费方按「方法缺席」处理（见 packages/api/src/index.ts 的 TradeService 注释）。
   */
  async getOrder(_symbol: string, _id: string): Promise<Order> {
    throw new TradingServiceError(
      'TRADING_NOT_IMPLEMENTED',
      'Tushare TradeService.getOrder is not implemented: Tushare is a market-data service and this connector has no trading-account channel. '
        + 'That means "not available", NOT "order not found".',
    )
  }

  async getPositions(): Promise<Position[]> {
    throw new TradingServiceError(
      'TRADING_NOT_IMPLEMENTED',
      'Tushare TradeService.getPositions is not implemented: Tushare is a market-data service and this connector has no trading-account channel. '
        + 'That means "not available", NOT "no positions".',
    )
  }
}

export const ROUTER_PROVIDER = 'tushare'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

interface RouterCredentialSource {
  getCredential?(provider: string): Record<string, string> | undefined
}

/**
 * 惰性凭证源（主入口与 dataplane 行共用同一份）：设置中心
 * `dshtrading.credentials.tushare.token`（router getCredential）优先、`process.env[tokenRef]`
 * 兜底，**每次请求解析** —— settings 用户层加载/修改晚于插件 apply 也生效。
 * `tokenRef` 语义不变：仍是指向环境变量名的 BYOK 引用，凭证值本身只经 ref 与设置中心。
 */
export function createTokenProvider(ctx: Context, tokenRef: string): () => string | undefined {
  return () => {
    const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as RouterCredentialSource | undefined
    return router?.getCredential?.(ROUTER_PROVIDER)?.token || process.env[tokenRef]
  }
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'cn')) return

  const tokenProvider = createTokenProvider(ctx, config.tokenRef)
  const marketData = new TushareMarketDataService(ctx, { tokenProvider })
  const trade = new TushareTradeService(ctx, { tokenProvider, config })

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'cn_get_ticker',
      description: 'Get the latest trade price and quote for an A-share stock via Tushare Pro API.',
      parameters: { symbol: { type: 'string', required: true, description: 'A-share stock symbol, e.g. 600519.SH' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'cn_get_klines',
      description: 'Get recent public klines for an A-share stock via Tushare Pro API. Supports 1m/5m/15m/30m/1h/1d/1w/1M.',
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
      name: 'cn_get_valuation',
      description: 'Get daily valuation metrics (PE, PB, turnover rate, total market cap) for an A-share stock via Tushare Pro.',
      parameters: { symbol: { type: 'string', required: true, description: 'A-share stock symbol, e.g. 600519.SH' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const basic = await marketData.getDailyBasic(args.symbol)
        return JSON.stringify(basic)
      },
    }))
  })
}
