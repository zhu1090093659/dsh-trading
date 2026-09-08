/**
 * @dshtrading/connector-eastmoney
 * 东方财富 A 股连接器插件（提供 tradingCnMarketData 与 cn_* 行情工具）。
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
  EastmoneyRestClient,
  type EastmoneyRestOptions,
  INTERVAL_VOCABULARY,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-cn-connector-eastmoney'

export interface Config {
  enabled: boolean
  /** 市场分流（单包双市场，照抄 connector-tencent 模式）：cn=A 股（缺省），hk=港股（trends2 分钟线实证）。 */
  market?: 'cn' | 'hk'
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活东财连接器'),
  market: Schema.union(['cn', 'hk']).default('cn').description('市场：cn=A 股，hk=港股'),
})

export const TRADING_CN_MARKET_DATA_KEY = 'tradingCnMarketData'
export const TRADING_HK_MARKET_DATA_KEY = 'tradingHkMarketData'

export function marketDataKey(market: 'cn' | 'hk'): string {
  return market === 'hk' ? TRADING_HK_MARKET_DATA_KEY : TRADING_CN_MARKET_DATA_KEY
}

export class EastmoneyMarketDataService extends Service implements MarketDataService {
  private readonly client: EastmoneyRestClient

  constructor(
    ctx: Context,
    options: EastmoneyRestOptions = {},
    serviceName: string = TRADING_CN_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new EastmoneyRestClient(options)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
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

export const ROUTER_PROVIDER = 'eastmoney'

export function routeAllows(ctx: Context, config: Config, market: 'cn' | 'hk'): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const market = config.market ?? 'cn'
  if (!routeAllows(ctx, config, market)) return

  const marketData = new EastmoneyMarketDataService(ctx, {}, marketDataKey(market))

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: `${market}_get_ticker`,
      description: market === 'hk' ? 'Get the latest trade price and quote for a HK stock via Eastmoney API.' : 'Get the latest trade price and quote for an A-share stock via Eastmoney API.',
      parameters: { symbol: { type: 'string', required: true, description: market === 'hk' ? 'HK stock symbol, e.g. 00700.HK' : 'A-share stock symbol, e.g. 600519.SH' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: `${market}_get_klines`,
      description: market === 'hk' ? 'Get recent public klines for a HK stock via Eastmoney API. 1m = 当日分时（trends2）；5m/15m/30m/1h/1d/1w/1M 走 kline。' : 'Get recent public klines for an A-share stock via Eastmoney API. Supports 1m/5m/15m/30m/1h/1d/1w/1M.',
      parameters: {
        symbol: { type: 'string', required: true, description: market === 'hk' ? 'HK stock symbol, e.g. 00700.HK' : 'A-share stock symbol, e.g. 600519.SH' },
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
