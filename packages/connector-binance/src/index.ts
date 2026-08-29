/**
 * Binance 连接器插件（dsh-trading crypto 切片）：真实 MarketDataService。
 *
 * 能力三角色：
 * - 声明：ctx 键 `tradingCryptoMarketData` 由 @dsh-trading/api 的模块增强统一声明；
 * - provide：BinanceMarketDataService（Service 基类，随插件 fiber 自动注销）；
 * - inject：工具经 ctx.inject 等待服务就绪后注册，一律经服务执行，不直连 REST。
 *
 * REST 数据面见 ./rest.ts（可独立单测/脚本消费）；错误词汇映射 @dsh-trading/api
 * 的 TradingErrorCode（TradingServiceError.code）。
 *
 * @module @dsh-trading/connector-binance
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type { Disposable, Interval, Kline, MarketDataService, Ticker } from '@dsh-trading/api'
import { BinanceRestClient, INTERVAL_VOCABULARY } from './rest.js'
import type { BinanceRestOptions } from './rest.js'

export * from './rest.js'

/**
 * Cordis 插件名 = patch 行 id（TEMPLATES §8）：`dsh-trading-crypto-*` 市场命名空间，
 * 全仓唯一，绝不使用 `base` 等官方保留 id（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-crypto-connector-binance'

export interface Config {
  /** 交易安全闸门（铁律 #3）：true 时下单类工具强制 dry-run。 */
  dryRun: boolean
  /** 实盘总闸门：默认 false；false 时无论 dryRun 与否都拒绝实盘下单 [S4]。 */
  liveTrading: boolean
}

export const Config: Schema<Config> = Schema.object({
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
})

/** 需要宿主提供的 Cordis 服务。 */
export const inject = ['tools']

/* ------------------------------------------------------------------ */
/* MarketDataService（provide 到市场命名空间 ctx 键）                      */
/* ------------------------------------------------------------------ */

/** ctx 服务键：与 @dsh-trading/api 的 Context 模块增强一致（市场命名空间）。 */
export const TRADING_CRYPTO_MARKET_DATA_KEY = 'tradingCryptoMarketData'

export interface SubscribeTickerOptions {
  /** 轮询间隔（ms）。切片阶段 subscribeTicker 以 REST 轮询实现，WS 在后续任务。 */
  readonly intervalMs?: number
}

const SUBSCRIBE_MIN_MS = 250
const SUBSCRIBE_DEFAULT_MS = 5_000

export class BinanceMarketDataService extends Service implements MarketDataService {
  readonly #client: BinanceRestClient

  constructor(ctx: Context, options: BinanceRestOptions = {}, name: string = TRADING_CRYPTO_MARKET_DATA_KEY) {
    super(ctx, name)
    this.#client = new BinanceRestClient(options)
  }

  getTicker(symbol: string): Promise<Ticker> {
    return this.#client.getTicker(symbol)
  }

  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    return this.#client.getKlines(symbol, interval, limit)
  }

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: SubscribeTickerOptions): Disposable {
    const ms = Math.max(options?.intervalMs ?? SUBSCRIBE_DEFAULT_MS, SUBSCRIBE_MIN_MS)
    const tick = (): void => {
      // 轮询失败静默跳过（下一 tick 重试）；不产生未处理 rejection。
      void this.#client.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}

/* ------------------------------------------------------------------ */
/* 工具注册（经服务执行）                                                 */
/* ------------------------------------------------------------------ */

export function apply(ctx: Context): void {
  // provide：Service 基类随插件 fiber 注册，插件卸载自动注销。
  new BinanceMarketDataService(ctx)

  // inject：等行情服务就绪后注册工具；工具只面向服务接口，不直连 REST。
  ctx.inject(['tradingCryptoMarketData'], (ctx) => {
    const marketData = ctx.tradingCryptoMarketData

    ctx.tools.register(
      defineTool({
        name: 'crypto_get_ticker',
        description:
          'Get the latest public ticker (last price, bid/ask, 24h volume) for a crypto symbol via the Binance public REST API. No credentials required.',
        parameters: {
          symbol: {
            type: 'string',
            required: true,
            description: 'Trading pair symbol, e.g. BTCUSDT',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const ticker = await marketData.getTicker(args.symbol)
          return JSON.stringify(ticker)
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'crypto_get_klines',
        description:
          'Get recent public klines (candles: open/high/low/close/volume) for a crypto symbol via the Binance public REST API. No credentials required.',
        parameters: {
          symbol: {
            type: 'string',
            required: true,
            description: 'Trading pair symbol, e.g. BTCUSDT',
          },
          interval: {
            type: 'string',
            enum: INTERVAL_VOCABULARY,
            description: 'Kline interval (Binance vocabulary)',
            default: '1h',
          },
          limit: {
            type: 'integer',
            description: 'Number of candles to return (1-1000)',
            default: 100,
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const interval = (args.interval ?? '1h') as Interval
          const limit = args.limit ?? 100
          const klines = await marketData.getKlines(args.symbol, interval, limit)
          return JSON.stringify(klines)
        },
      }),
    )
  })
}
