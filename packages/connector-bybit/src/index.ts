/**
 * @dshtrading/connector-bybit
 * Bybit 加密货币连接器插件（提供 tradingCryptoMarketData 与 crypto_* 工具）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type {
  AccountBalance,
  DerivativesData,
  DerivativesHistory,
  Disposable,
  Interval,
  Kline,
  MarketDataService,
  Order,
  OrderRequest,
  Orderbook,
  Position,
  Ticker,
  TradeFill,
  TradeService,
  TradeTick,
} from '@dshtrading/api'
import {
  BybitRestClient,
  type BybitRestOptions,
  INTERVAL_VOCABULARY,
  TradingServiceError,
  normalizeCryptoSymbol,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-crypto-connector-bybit'

export interface Config {
  enabled: boolean
  env: 'demo' | 'live'
  dryRun: boolean
  liveTrading: boolean
  apiKeyRef: string
  secretRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 Bybit 连接器'),
  env: Schema.union(['demo', 'live'] as const).default('demo').description('运行环境'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单'),
  liveTrading: Schema.boolean().default(false).description('是否允许实盘交易'),
  apiKeyRef: Schema.string().default('BYBIT_API_KEY').description('Bybit API Key 环境变量名 (BYOK)'),
  secretRef: Schema.string().default('BYBIT_SECRET_KEY').description('Bybit Secret Key 环境变量名'),
})

export const TRADING_CRYPTO_MARKET_DATA_KEY = 'tradingCryptoMarketData'
export const TRADING_CRYPTO_TRADE_KEY = 'tradingCryptoTrade'

export class BybitMarketDataService extends Service implements MarketDataService {
  private readonly client: BybitRestClient

  constructor(
    ctx: Context,
    options: BybitRestOptions = {},
    serviceName: string = TRADING_CRYPTO_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new BybitRestClient(options)
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

  /** 盘口快照（api 可选契约 getOrderbook，issue #39）：spot orderbook 25 档透传。 */
  async getOrderbook(symbol: string): Promise<Orderbook> {
    return this.client.getOrderbook(symbol)
  }

  /** 最近逐笔成交（api 可选契约 getRecentTrades，issue #39），时间升序。 */
  async getRecentTrades(symbol: string, limit = 50): Promise<TradeTick[]> {
    return this.client.getRecentTrades(symbol, limit)
  }

  /**
   * 衍生品指标快照（api 可选契约 getDerivatives，issue #38）：聚合 Bybit v5 线性合约
   * 公共端点（tickers?category=linear 的 fundingRate/OI + account-ratio 多空比）。
   * 任一子查询失败只降级该字段（undefined，面板按缺格隐藏）；全部失败才抛结构化错误
   * （桥层转 ok:false，前端不弹横幅）。输出 symbol 为规范 SWAP 形（BTCUSDT-SWAP）。
   */
  async getDerivatives(symbol: string): Promise<DerivativesData> {
    const sym = normalizeCryptoSymbol(symbol)
    const unavailable: string[] = []
    const collect = <T>(label: string, task: Promise<T>): Promise<T | undefined> =>
      task.catch((error) => {
        unavailable.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })

    const [ticker, ratio] = await Promise.all([
      collect('linear-tickers', this.client.getLinearTickerSnapshot(sym)),
      collect('account-ratio', this.client.getLinearAccountRatio(sym)),
    ])

    const fundingRate = ticker?.fundingRate
    const openInterest = ticker?.openInterest
    const openInterestValue = ticker?.openInterestValue
    const longShortRatio = ratio !== undefined && ratio.sellRatio > 0 ? ratio.buyRatio / ratio.sellRatio : undefined

    if (fundingRate === undefined && openInterest === undefined && openInterestValue === undefined
      && longShortRatio === undefined) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Bybit derivatives for ${sym}: all sub-queries failed`
          + (unavailable.length > 0 ? ` (${unavailable.join('; ')})` : ''),
      )
    }
    return {
      symbol: `${sym}-SWAP`,
      source: 'bybit',
      ...(openInterest !== undefined ? { openInterest } : {}),
      ...(openInterestValue !== undefined ? { openInterestValue } : {}),
      ...(longShortRatio !== undefined ? { longShortRatio } : {}),
      ...(fundingRate !== undefined ? { fundingRate } : {}),
      ...(ticker?.nextFundingTime !== undefined ? { nextFundingTime: ticker.nextFundingTime } : {}),
      ...(ticker?.markPrice !== undefined ? { markPrice: ticker.markPrice } : {}),
      ...(ticker?.indexPrice !== undefined ? { indexPrice: ticker.indexPrice } : {}),
      timestamp: Date.now(),
    }
  }

  /**
   * 衍生品历史序列（api 可选契约 getDerivativesHistory，issue #54）：
   * funding/history + open-interest 双端点聚合并发拉取，任一失败只降级该序列
   * （字段缺省 → 对应趋势卡隐藏），全部失败才抛结构化错误。
   */
  async getDerivativesHistory(symbol: string): Promise<DerivativesHistory> {
    const sym = normalizeCryptoSymbol(symbol)
    const unavailable: string[] = []
    const collect = <T>(label: string, task: Promise<T>): Promise<T | undefined> =>
      task.catch((error) => {
        unavailable.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })

    const [fundingRates, openInterest] = await Promise.all([
      collect('funding-history', this.client.getLinearFundingHistory(sym, 30)),
      collect('oi-history', this.client.getLinearOpenInterestHistory(sym, 30)),
    ])

    if (fundingRates === undefined && openInterest === undefined) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Bybit derivatives history for ${sym}: all sub-queries failed`
          + (unavailable.length > 0 ? ` (${unavailable.join('; ')})` : ''),
      )
    }
    return {
      symbol: `${sym}-SWAP`,
      source: 'bybit',
      ...(fundingRates !== undefined && fundingRates.length > 0 ? { fundingRates } : {}),
      ...(openInterest !== undefined && openInterest.length > 0 ? { openInterest } : {}),
    }
  }
}

export class BybitTradeService extends Service implements TradeService {
  private readonly client: BybitRestClient
  /** 插件配置（服务缝闸门 P0：dryRun 强制模拟 / liveTrading 总闸门）。 */
  private readonly config: Config

  constructor(
    ctx: Context,
    options: BybitRestOptions & { config: Config },
    serviceName: string = TRADING_CRYPTO_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new BybitRestClient(options)
    this.config = options.config
  }

  async getBalance(): Promise<AccountBalance> {
    return this.client.getBalance()
  }

  async getBalances(): Promise<AccountBalance[]> {
    try {
      const b = await this.client.getBalance()
      return [b]
    } catch {
      return []
    }
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    // 服务缝闸门（P0 · 铁律 #3 修订版 [S4]）：三态检查下推到服务实现内第一步——
    // 绕过工具层直调本服务（动态包宿主半等）同样 fail-closed；工具层闸门保留（双保险）。
    const requestedDryRun = order.dryRun ?? true
    if (!requestedDryRun && !this.config.liveTrading) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        `Bybit TradeService.placeOrder rejected: the request asks for real execution (dryRun=${String(order.dryRun)}) `
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
    if (!this.config.liveTrading || this.config.dryRun) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        'Bybit TradeService.cancelOrder rejected at the service seam: cancel is a live action and requires liveTrading=true with dryRun=false.',
      )
    }
    return this.client.cancelOrder(undefined, orderId) as unknown as void
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

  async getPositions(): Promise<Position[]> {
    return []
  }

  async listOpenOrders(_symbol?: string): Promise<Order[]> {
    return []
  }

  async listTradeFills(_symbol?: string, _limit?: number): Promise<TradeFill[]> {
    return []
  }
}

export const ROUTER_PROVIDER = 'bybit'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'crypto')) return

  const apiKey = process.env[config.apiKeyRef]
  const apiSecret = process.env[config.secretRef]
  const marketData = new BybitMarketDataService(ctx, { apiKey, apiSecret })
  const trade = new BybitTradeService(ctx, { apiKey, apiSecret , config })
  void marketData
  void trade

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'crypto_get_ticker',
      description: 'Get the latest trade price and quote for a crypto pair via Bybit API.',
      parameters: { symbol: { type: 'string', required: true, description: 'Crypto pair symbol, e.g. BTCUSDT' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'crypto_get_klines',
      description: 'Get recent public klines for a crypto pair via Bybit API. Supports 1m/5m/15m/30m/1h/4h/1d/1w/1M.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'Crypto pair symbol, e.g. BTCUSDT' },
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
