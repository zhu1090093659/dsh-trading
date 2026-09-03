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

export * from './rest.js'
export * from './types.js'

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

  async getKlines(_symbol: string, _interval: Interval = '1d', _limit: number = 100): Promise<Kline[]> {
    throw new TradingServiceError('TRADING_NOT_IMPLEMENTED', 'HiThink K-lines not supported yet')
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
  const apiKey = process.env[config.apiKeyRef]
  new HiThinkMarketDataService(ctx, apiKey ? { apiKey } : {})
}
