/**
 * Yahoo Finance 连接器插件（dsh-trading us 切片，任务 G 数据面切换）。
 *
 * 能力三角色（与 connector-stooq/binance 同构）：
 * - 声明：ctx 键 `tradingUsMarketData` 由 @dsh-trading/api 的模块增强统一声明；
 * - provide：YahooMarketDataService（Service 基类，随插件 fiber 自动注销）；
 * - inject：工具经 ctx.inject 等待服务就绪后注册，一律经服务执行，不直连 HTTP。
 *
 * 下单三段闸门语义照抄 crypto/us 切片（README 铁律 #3 / S4 修订）：工具名 `us_place_order`
 * 落在 base 闸门模式 `/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/`；审批不在工具内做。
 * Yahoo 本身无交易 API——live 路径恒为 TRADING_NOT_IMPLEMENTED（券商 API 是后续任务）。
 *
 * 合规（README 铁律 #5）：Yahoo Finance 非官方 API，个人使用属灰色但被普遍使用的边界；
 * 无 key、本仓不缓存不再分发（详见 README 数据源节与 src/rest.ts 头注）。
 *
 * @module @dsh-trading/connector-yahoo
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type { Disposable, Interval, Kline, MarketDataService, Ticker } from '@dsh-trading/api'
import {
  INTERVAL_VOCABULARY,
  type YahooRestOptions,
  YahooRestClient,
  TradingServiceError,
  normalizeYahooSymbol,
} from './rest.js'

export * from './rest.js'

/**
 * Cordis 插件名 = patch 行 id（TEMPLATES §8）：`dsh-trading-us-*` 市场命名空间，
 * 全仓唯一（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-us-connector-yahoo'

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
export const TRADING_US_MARKET_DATA_KEY = 'tradingUsMarketData'

export interface SubscribeTickerOptions {
  /** 轮询间隔（ms）。subscribeTicker 以 meta 快照轮询实现（Yahoo 无官方推送面）。 */
  readonly intervalMs?: number
}

const SUBSCRIBE_MIN_MS = 250
const SUBSCRIBE_DEFAULT_MS = 5_000

export class YahooMarketDataService extends Service implements MarketDataService {
  // TS 编译期 private 而非 ECMAScript #（cordis realm 代理按类身份炸，README 定稿 5）。
  private readonly client: YahooRestClient

  constructor(ctx: Context, options: YahooRestOptions = {}, name: string = TRADING_US_MARKET_DATA_KEY) {
    super(ctx, name)
    this.client = new YahooRestClient(options)
  }

  getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval).then((all) =>
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? all.slice(-limit) : all,
    )
  }

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: SubscribeTickerOptions): Disposable {
    const ms = Math.max(options?.intervalMs ?? SUBSCRIBE_DEFAULT_MS, SUBSCRIBE_MIN_MS)
    const tick = (): void => {
      // 轮询失败静默跳过（下一 tick 重试）；不产生未处理 rejection。
      void this.client.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}

/* ------------------------------------------------------------------ */
/* us_place_order（交易安全闸门：铁律 #3 修订版 [S4]，三路径语义照抄 crypto）  */
/* ------------------------------------------------------------------ */

/** us_place_order 参数契约（美股词汇，dryRun 缺省 true）。 */
export interface PlaceOrderArgs {
  /** 股票代码，如 `AAPL` 或 `brk-b`（执行前归一化为 Yahoo 大写形态）。 */
  readonly symbol: string
  readonly side: 'BUY' | 'SELL'
  readonly type: 'MARKET' | 'LIMIT'
  /** 股数（整股），必须 > 0。 */
  readonly quantity: number
  /** LIMIT 单必填（schema 无法条件必填，execute 内校验），必须 > 0。 */
  readonly price?: number
  /** 缺省视为 true：仅模拟。显式 false 即实盘意图，进入闸门 ①/③。 */
  readonly dryRun?: boolean
}

/**
 * 闸门判定结果（三条路径与裁决顺序与 crypto/stooq 同构，见 connector-binance evaluateOrderGate）。
 */
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
        `us_place_order rejected: the call requests real execution (dryRun=${String(args.dryRun)}) `
        + 'but live trading is disabled (liveTrading=false). Ask the user to enable liveTrading explicitly '
        + 'after confirmation, or keep dryRun=true for a simulated fill.',
    }
  }
  if (requestedDryRun || config.dryRun) return { action: 'simulate' }
  return { action: 'live' }
}

/** 参数校验（模型调用问题抛普通 Error，与 crypto 先例一致；服务故障才用错误词汇）。 */
function validatePlaceOrderArgs(args: PlaceOrderArgs): void {
  // 符号形态在这里只做宽松校验（非空字符串）；规范化/严格校验在服务层（normalizeYahooSymbol）。
  if (typeof args.symbol !== 'string' || !args.symbol.trim()) {
    throw new Error('us_place_order: invalid symbol — expected a US ticker like AAPL or BRK-B')
  }
  try {
    normalizeYahooSymbol(args.symbol)
  } catch (cause) {
    throw new Error(`us_place_order: invalid symbol ${JSON.stringify(args.symbol)} — expected a US ticker like AAPL`, { cause })
  }
  if (args.side !== 'BUY' && args.side !== 'SELL') {
    throw new Error(`us_place_order: invalid side ${JSON.stringify(args.side)} — expected BUY or SELL`)
  }
  if (args.type !== 'MARKET' && args.type !== 'LIMIT') {
    throw new Error(`us_place_order: invalid type ${JSON.stringify(args.type)} — expected MARKET or LIMIT`)
  }
  if (typeof args.quantity !== 'number' || !Number.isFinite(args.quantity) || args.quantity <= 0) {
    throw new Error(`us_place_order: invalid quantity ${JSON.stringify(args.quantity)} — expected a positive number`)
  }
  if (args.type === 'LIMIT' && (typeof args.price !== 'number' || !Number.isFinite(args.price) || args.price <= 0)) {
    throw new Error('us_place_order: LIMIT orders require a positive price')
  }
}

function normalizePlaceOrderArgs(raw: unknown): PlaceOrderArgs {
  const args = (raw ?? {}) as PlaceOrderArgs
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : (undefined as unknown as string)
  return { ...args, symbol }
}

/** DRY-RUN 回执：模拟成交 + Yahoo 最新 regular-market 参照（参照取不到不阻断模拟本身）。 */
export interface DryRunReference {
  source: 'yahoo-regular-market'
  price?: number
  volume?: number
  timestamp?: number
  unavailable?: string
}

export async function buildDryRunReceipt(
  args: PlaceOrderArgs,
  marketData: Pick<MarketDataService, 'getTicker'>,
): Promise<string> {
  const symbol = normalizeYahooSymbol(args.symbol)
  let reference: DryRunReference
  try {
    const ticker = await marketData.getTicker(symbol)
    reference = {
      source: 'yahoo-regular-market',
      price: ticker.price,
      volume: ticker.volume,
      timestamp: ticker.timestamp,
    }
  } catch (error) {
    // 模拟单不因参照行情失败而失败：明确标注 unavailable 即可。
    reference = {
      source: 'yahoo-regular-market',
      unavailable: error instanceof Error ? error.message : String(error),
    }
  }
  return JSON.stringify({
    status: 'filled',
    dryRun: true,
    note:
      'DRY-RUN — simulated fill; no order was sent to any broker. Yahoo Finance is a data source only (no trading API); '
      + 'the reference price is the latest regular-market price, which may not reflect pre/post-market moves.',
    id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side: args.side.toLowerCase(),
    type: args.type.toLowerCase(),
    quantity: args.quantity,
    ...(args.type === 'LIMIT' ? { price: args.price } : {}),
    reference,
    timestamp: Date.now(),
  })
}

export interface PlaceOrderToolDeps {
  /** 行情服务（dry-run 回执的市价参照），按接口取用，不直连 HTTP。 */
  readonly marketData: Pick<MarketDataService, 'getTicker'>
  /** 插件配置（dryRun 强制模拟 / liveTrading 总闸门）。 */
  readonly config: Config
}

/**
 * us_place_order 工具工厂（独立导出便于单测三条闸门路径）。
 *
 * 审批不在这里做：dryRun!==true 的调用由 @dsh-trading/base 的 gate 插件在
 * `tools/pre-execute` waterfall 统一 ask（S4：headless 下 ask=deny，fail-closed）。
 */
export function createPlaceOrderTool(deps: PlaceOrderToolDeps) {
  return defineTool({
    name: 'us_place_order',
    description:
      'Place a US stock order, or simulate one. dryRun defaults to true and returns a DRY-RUN simulated fill receipt '
      + 'referencing the latest Yahoo Finance regular-market price. Real execution (dryRun=false) requires the plugin '
      + 'liveTrading switch plus user approval, and is not implemented yet in this slice (Yahoo has no trading API).',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'US stock ticker, e.g. AAPL or BRK-B',
      },
      side: {
        type: 'string',
        enum: ['BUY', 'SELL'],
        required: true,
        description: 'Order side',
      },
      type: {
        type: 'string',
        enum: ['MARKET', 'LIMIT'],
        required: true,
        description: 'Order type',
      },
      quantity: {
        type: 'number',
        required: true,
        description: 'Share quantity (whole shares), must be > 0',
      },
      price: {
        type: 'number',
        description: 'Limit price; required when type=LIMIT',
      },
      dryRun: {
        type: 'boolean',
        description:
          'true (default) = simulate only and return a DRY-RUN receipt; false = request real execution (gated by liveTrading and user approval)',
        default: true,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = normalizePlaceOrderArgs(raw)
      validatePlaceOrderArgs(args)

      const verdict = evaluateOrderGate(deps.config, args)
      if (verdict.action === 'reject') {
        // 闸门 ①：结构化拒绝，不抛异常（模型可直接读到原因与出路）。
        return JSON.stringify({ status: 'rejected', code: verdict.code, message: verdict.message })
      }
      if (verdict.action === 'simulate') {
        // 闸门 ②：模拟成交回执（DRY-RUN 标记 + regular-market 参照）。
        return buildDryRunReceipt(args, deps.marketData)
      }
      // 闸门 ③：实盘执行未实现（Yahoo 无交易 API；券商下单是后续任务）。
      throw new TradingServiceError(
        'TRADING_NOT_IMPLEMENTED',
        'us_place_order: live order execution is not implemented in this slice — Yahoo Finance provides market data only; '
        + 'a broker API (e.g. Alpaca/IBKR) is a follow-up. Keep dryRun=true for simulated fills.',
      )
    },
  })
}

export function apply(ctx: Context, config: Config): void {
  // provide：Service 基类随插件 fiber 注册，插件卸载自动注销。
  new YahooMarketDataService(ctx)

  // inject：等行情服务就绪后注册工具；工具只面向服务接口，不直连 HTTP。
  ctx.inject(['tradingUsMarketData'], (ctx) => {
    const marketData = ctx.tradingUsMarketData

    ctx.tools.register(
      defineTool({
        name: 'us_get_ticker',
        description:
          'Get the latest market snapshot for a US stock via the Yahoo Finance v8 chart API (unofficial; no key). '
          + 'Returns the latest regular-market price and time (meta.regularMarketPrice/Time) plus the latest daily '
          + 'bar\'s volume — note Yahoo may consolidate the most recent completed session\'s daily bar with a lag, so '
          + 'volume can trail the latest session. Personal use per Yahoo terms of use.',
        parameters: {
          symbol: {
            type: 'string',
            required: true,
            description: 'US stock ticker, e.g. AAPL or BRK-B (normalized to upper-case internally)',
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
        name: 'us_get_klines',
        description:
          'Get recent OHLCV candles for a US stock via the Yahoo Finance v8 chart API (unofficial; no key). '
          + 'Supported intervals: 1m/5m/15m/30m (intraday history is limited by Yahoo: 1m caps at ~7 days), 1h, 1d, '
          + '1w, 1M. Personal use per Yahoo terms of use.',
        parameters: {
          symbol: {
            type: 'string',
            required: true,
            description: 'US stock ticker, e.g. AAPL or BRK-B (normalized to upper-case internally)',
          },
          interval: {
            type: 'string',
            enum: INTERVAL_VOCABULARY,
            description: 'Kline interval (Yahoo-supported subset)',
            default: '1d',
          },
          limit: {
            type: 'integer',
            description: 'Number of most recent candles to return (1-1000; the client fetches a fixed window and the tool trims)',
            default: 100,
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const interval = (args.interval ?? '1d') as Interval
          const limit = args.limit ?? 100
          const klines = await marketData.getKlines(args.symbol, interval, limit)
          return JSON.stringify(klines)
        },
      }),
    )

    // 交易安全闸门（铁律 #3 修订版 [S4]）：三条路径见 evaluateOrderGate；
    // dryRun!==true 的审批由 base 的 gate 插件统一在 pre-execute 承担。
    ctx.tools.register(
      createPlaceOrderTool({ marketData, config }),
    )
  })
}
