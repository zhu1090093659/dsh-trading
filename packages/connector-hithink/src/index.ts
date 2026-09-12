/**
 * @dshtrading/connector-hithink
 * 同花顺官方金融数据服务 (HiThink-Tech) A 股连接器插件。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  AuctionSnapshot,
  Disposable,
  Interval,
  Kline,
  LimitUpPoolItem,
  MarketDataService,
  StockFundamentals,
  Ticker,
} from '@dshtrading/api'
import {
  HiThinkRestClient,
  type HiThinkRestOptions,
  TradingServiceError,
} from './rest.js'
import { aggregateDailyKlines, dailyBarToKline } from './kline.js'

export * from './rest.js'
export * from './types.js'
export * from './kline.js'

export const name = 'dsh-trading-cn-connector-hithink'

export interface Config {
  enabled: boolean
  apiKeyRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活同花顺连接器'),
  apiKeyRef: Schema.string().default('HITHINK_FINANCE_API_KEY').description('同花顺 API Key 环境变量名 (BYOK)'),
})

export const TRADING_CN_MARKET_DATA_KEY = 'tradingCnMarketData'

export class HiThinkMarketDataService extends Service implements MarketDataService {
  private readonly client: HiThinkRestClient

  constructor(
    ctx: Context,
    options: HiThinkRestOptions = {},
    serviceName: string = TRADING_CN_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new HiThinkRestClient(options)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  /**
   * A 股 K 线。上游仅开放日线（高频分钟模块未开放外部接入）：
   * 1d 直连 /api/a-share/prices/historical（前复权）；3d/1w/1M 由日线本地聚合；
   * 分钟级周期抛 TRADING_UNSUPPORTED_INTERVAL（需分钟 K 时切换 cn provider 至 tencent 等）。
   */
  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const n = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 100, 1000))
    if (interval !== '1d' && interval !== '3d' && interval !== '1w' && interval !== '1M') {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_INTERVAL',
        `HiThink A-share K-lines only support 1d/3d/1w/1M (upstream minute module not open); got ${interval}`,
      )
    }
    const dailyBars = await this.client.getHistoricalDailyKlines(symbol, interval === '1d' ? n : Math.min(n * 35, 1000))
    const daily = dailyBars.map((b) => dailyBarToKline(
      b.date_ms as number,
      b.open_price as number,
      b.high_price as number,
      b.low_price as number,
      b.close_price as number,
      b.volume ?? 0,
    ))
    if (interval === '1d') return daily
    const aggregated = aggregateDailyKlines(daily, interval)
    return aggregated.slice(-n)
  }

  async getStockFundamentals(symbol: string): Promise<StockFundamentals> {
    return this.client.getStockFundamentals(symbol)
  }

  async getAuctionSnapshot(symbol: string): Promise<AuctionSnapshot | undefined> {
    return this.client.getAuctionSnapshot(symbol)
  }

  async getLimitUpPool(options?: { dateMs?: number; page?: number; size?: number }): Promise<LimitUpPoolItem[]> {
    return this.client.getLimitUpPool(options)
  }

  async getLimitUpLadder() {
    return this.client.getLimitUpLadder()
  }

  async searchTickers(query: string) {
    return this.client.searchTickers(query)
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

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  // 凭证对齐 tushare/fmp 等商业连接器（2026-09-12 实证修复）：设置中心
  // dshtrading.credentials.hithink.apiKey（router getCredential）优先，环境变量兜底。
  // 解析惰性到每次请求：settings 用户层加载与修改晚于插件 apply（热切换即时生效）。
  const apiKeyProvider = (): string | undefined => {
    const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as
      | { getCredential?(provider: string): Record<string, string> | undefined }
      | undefined
    return router?.getCredential?.('hithink')?.apiKey || process.env[config.apiKeyRef]
  }
  new HiThinkMarketDataService(ctx, { apiKeyProvider })
}
