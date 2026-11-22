/**
 * @dshtrading/connector-akshare
 * 包名取 AkShare，实现面是东方财富公开 REST 直连（push2 / push2his）：
 * 提供 tradingCnMarketData 行情服务与 3 个 cn_* 工具，无交易通道。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type {
  Disposable,
  Interval,
  Kline,
  MarketDataService,
  Ticker,
} from '@dshtrading/api'
import {
  AkshareRestClient,
  type AkshareRestOptions,
  INTERVAL_VOCABULARY,
  SUPPORTED_KLINES_INTERVALS,
} from './rest.js'
export * from './rest.js'

export const name = 'dsh-trading-cn-connector-akshare'

export interface Config {
  enabled: boolean
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 AkShare 连接器'),
})

export const TRADING_CN_MARKET_DATA_KEY = 'tradingCnMarketData'

export interface AkshareMarketDataOptions extends AkshareRestOptions {}

export class AkshareMarketDataService extends Service implements MarketDataService {
  private readonly client: AkshareRestClient

  constructor(
    ctx: Context,
    options: AkshareMarketDataOptions = {},
    serviceName: string = TRADING_CN_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new AkshareRestClient(options)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
  }

  async getSectorFundFlow(): Promise<Array<{ name: string; changePercent: number; mainNetInflow: number }>> {
    return this.client.getSectorFundFlow()
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

export const ROUTER_PROVIDER = 'akshare'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'cn')) return

  const marketData = new AkshareMarketDataService(ctx)

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'cn_get_ticker',
      description: 'Get the latest trade price and quote for an A-share stock via AkShare/Eastmoney API.',
      parameters: { symbol: { type: 'string', required: true, description: 'A-share stock symbol, e.g. 600519.SH' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'cn_get_klines',
      description: 'Get recent public klines for an A-share stock via AkShare/Eastmoney API.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'A-share stock symbol, e.g. 600519.SH' },
        interval: {
          type: 'string',
          enum: INTERVAL_VOCABULARY,
          default: '1d',
          description: `Interval (Eastmoney kline/get serves ${SUPPORTED_KLINES_INTERVALS.join('/')}; 1m and other values are rejected with TRADING_UNSUPPORTED_INTERVAL)`,
        },
        limit: { type: 'integer', default: 100, description: 'Limit' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const klines = await marketData.getKlines(args.symbol, (args.interval ?? '1d') as Interval, args.limit)
        return JSON.stringify(klines)
      },
    }))

    register(defineTool({
      name: 'cn_get_sector_fund_flow',
      description: 'Get sector/industry fund flow and main capital net inflow ranking via AkShare.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        const list = await marketData.getSectorFundFlow()
        return JSON.stringify(list)
      },
    }))
  })
}
