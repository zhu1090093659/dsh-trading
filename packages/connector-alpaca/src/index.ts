/**
 * Alpaca 连接器插件（dsh-trading us 切片）：MarketDataService 与 TradeService。
 *
 * @module @dsh-trading/connector-alpaca
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
  type AlpacaCredentials,
  type AlpacaRestOptions,
  AlpacaRestClient,
  INTERVAL_VOCABULARY,
  TradingServiceError,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-us-connector-alpaca'

export interface Config {
  enabled: boolean
  env: 'demo' | 'live'
  dryRun: boolean
  liveTrading: boolean
  apiKeyRef: string
  secretRef: string
  demoApiKeyRef: string
  demoSecretRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(false),
  env: Schema.union(['demo', 'live']).default('demo'),
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
  apiKeyRef: Schema.string().default('ALPACA_API_KEY'),
  secretRef: Schema.string().default('ALPACA_SECRET_KEY'),
  demoApiKeyRef: Schema.string().default('ALPACA_PAPER_API_KEY'),
  demoSecretRef: Schema.string().default('ALPACA_PAPER_SECRET_KEY'),
})

export const inject = ['tools']

export const TRADING_US_MARKET_DATA_KEY = 'tradingUsMarketData'
export const TRADING_US_TRADE_KEY = 'tradingUsTrade'

export interface CredentialResolverLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface CredentialsContext {
  get(name: string): unknown
}

export interface ResolvedCredentialRefs {
  readonly apiKeyRef: string
  readonly secretRef: string
}

export function credentialRefsFor(config: Config, env: 'demo' | 'live' = config.env): ResolvedCredentialRefs {
  return env === 'demo'
    ? { apiKeyRef: config.demoApiKeyRef, secretRef: config.demoSecretRef }
    : { apiKeyRef: config.apiKeyRef, secretRef: config.secretRef }
}

export async function resolveCredentials(
  ctx: CredentialsContext,
  refs: ResolvedCredentialRefs,
  env: 'demo' | 'live',
): Promise<AlpacaCredentials | undefined> {
  const entries: Array<[string, string]> = [
    ['apiKey', refs.apiKeyRef],
    ['secret', refs.secretRef],
  ]

  for (const [field, ref] of entries) {
    if (!CREDENTIAL_REF_PATTERN.test(ref)) {
      throw new TradingServiceError(
        'TRADING_CREDENTIALS_MISSING',
        `Alpaca ${env} credentials invalid: ${field} ref ${JSON.stringify(ref)} must match ^[A-Za-z_][A-Za-z0-9_]*$`,
      )
    }
  }

  const resolver = ctx.get('credentials') as CredentialResolverLike | undefined

  const resolved = await Promise.all(
    entries.map(async ([field, ref]) => {
      if (resolver !== undefined) {
        try {
          const res = await resolver.resolve(ref)
          if (res?.value) return { field, value: res.value }
        } catch {
          // ignore
        }
      }
      const envVal = process.env[ref]
      if (envVal) return { field, value: envVal }
      return { field, value: undefined }
    }),
  )

  const missing = resolved.filter((r) => !r.value).map((r) => r.field)
  if (missing.length > 0) {
    return undefined
  }

  const [apiKey, secret] = resolved.map((r) => r.value as string)
  return { key: apiKey, secret }
}

export class AlpacaMarketDataService extends Service implements MarketDataService {
  private readonly client: AlpacaRestClient
  private readonly getCredentials: () => Promise<AlpacaCredentials | undefined>

  constructor(
    ctx: Context,
    options: AlpacaRestOptions = {},
    getCredentials: () => Promise<AlpacaCredentials | undefined> = async () => undefined,
    serviceName: string = TRADING_US_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new AlpacaRestClient(options)
    this.getCredentials = getCredentials
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const creds = await this.getCredentials()
    return this.client.getTicker(symbol, creds)
  }

  async getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    const creds = await this.getCredentials()
    return this.client.getKlines(symbol, interval, limit, creds)
  }

  async listInstruments(): Promise<Array<{ symbol: string; name?: string }>> {
    const creds = await this.getCredentials()
    return this.client.listInstruments(creds)
  }

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: { intervalMs?: number }): Disposable {
    const ms = Math.max(options?.intervalMs ?? 5_000, 500)
    const tick = (): void => {
      void this.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}

export class AlpacaTradeService extends Service implements TradeService {
  private readonly client: AlpacaRestClient
  /** 插件配置（服务缝闸门 P0：dryRun 强制模拟 / liveTrading 总闸门）。 */
  private readonly config: Config
  private readonly getCredentials: () => Promise<AlpacaCredentials>

  constructor(
    ctx: Context,
    options: AlpacaRestOptions & { config: Config },
    getCredentials: () => Promise<AlpacaCredentials>,
    serviceName: string = TRADING_US_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new AlpacaRestClient(options)
    this.config = options.config
    this.getCredentials = getCredentials
  }

  async getBalance(): Promise<AccountBalance> {
    const creds = await this.getCredentials()
    return this.client.getBalance(creds)
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    // 服务缝闸门（P0 · 铁律 #3 修订版 [S4]）：三态检查下推到服务实现内第一步——
    // 绕过工具层直调本服务（动态包宿主半等）同样 fail-closed；工具层
    // evaluateOrderGate + base 审批闸门保留（双保险），三态语义与工具层一致。
    const requestedDryRun = order.dryRun ?? true
    if (!requestedDryRun && !this.config.liveTrading) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        `Alpaca TradeService.placeOrder rejected: the request asks for real execution (dryRun=${String(order.dryRun)}) `
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
    const creds = await this.getCredentials()
    return this.client.placeOrder(creds, {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      price: order.price,
    })
  }

  async cancelOrder(orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    // 服务缝闸门（P0）：撤单是会改变交易所真实状态的实盘动作，与真实下单同门槛。
    if (!this.config.liveTrading || this.config.dryRun) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        'Alpaca TradeService.cancelOrder rejected at the service seam: cancel is a live action and requires liveTrading=true with dryRun=false.',
      )
    }
    const creds = await this.getCredentials()
    return this.client.cancelOrder(creds, orderId)
  }

  async getPositions(): Promise<Position[]> {
    return []
  }

  async getOrders(): Promise<Order[]> {
    return []
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
        `us_place_order rejected: real execution requested (dryRun=${String(args.dryRun)}) `
        + 'but live trading is disabled (liveTrading=false). Enable liveTrading explicitly or keep dryRun=true.',
    }
  }
  if (requestedDryRun || config.dryRun) return { action: 'simulate' }
  return { action: 'live' }
}

export function createPlaceOrderTool(deps: { marketData: Pick<MarketDataService, 'getTicker'>; trade?: TradeService; config: Config }) {
  return defineTool({
    name: 'us_place_order',
    description: 'Place or simulate a US stock order via Alpaca. dryRun defaults to true for simulated execution.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'US stock symbol, e.g. AAPL' },
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

export const ROUTER_PROVIDER = 'alpaca'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'us')) return

  const credRefs = credentialRefsFor(config)
  const getCreds = () => resolveCredentials(ctx as unknown as CredentialsContext, credRefs, config.env)
  const requireCreds = async () => {
    const creds = await getCreds()
    if (!creds) {
      throw new TradingServiceError(
        'TRADING_CREDENTIALS_MISSING',
        `Alpaca credentials missing for ${config.env}. Set ${credRefs.apiKeyRef} and ${credRefs.secretRef}.`,
      )
    }
    return creds
  }

  const marketData = new AlpacaMarketDataService(ctx, { env: config.env }, getCreds)
  const trade = new AlpacaTradeService(ctx, { env: config.env, config }, requireCreds)

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'us_get_ticker',
      description: 'Get the latest trade price and quote for a US stock via Alpaca API.',
      parameters: { symbol: { type: 'string', required: true, description: 'US stock symbol, e.g. AAPL' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'us_get_klines',
      description: 'Get recent public klines for a US stock via Alpaca API. Supports 5m/15m/30m/1h/1d/1w/1M.',
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

    register(createPlaceOrderTool({ marketData, trade, config }))
  })
}
