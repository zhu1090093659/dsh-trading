/**
 * 腾讯行情连接器插件（dsh-trading cn+hk 双市场切片）：**单包双市场**——这是手册
 * （docs/replication.md §1-§4「一市场一连接器包」）之外的**多实例新模式**：
 *
 *   - 同一个插件包（插件名 `dsh-trading-tencent`，export const name）被挂载两次，
 *     preset 行用**不同行 id**（`dsh-trading-cn-connector` / `dsh-trading-hk-connector`）
 *     指向**同一 bare 包名**（`@dsh-trading/connector-tencent`），以 `config.market`
 *     分流 cn/hk（行 id 即命名空间——不同 id 即两个独立实例，互不整行替换）；
 *   - provide 服务键按实例分流：cn → `tradingCnMarketData`，hk → `tradingHkMarketData`
 *     （api 包 Context 模块增强统一声明两个键）；
 *   - 工具按市场注册：market=cn 挂 `cn_get_ticker/cn_get_klines/cn_place_order`，
 *     market=hk 挂 `hk_` 同名三件。工具前缀落在 base 闸门模式
 *     `/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/` 内，闸门接线与 crypto/us 同构。
 *
 * 下单三段闸门语义照抄 crypto/us 切片（README 铁律 #3 / S4 修订）；审批不在工具内做。
 * 腾讯本身无交易 API——live 路径恒为 TRADING_NOT_IMPLEMENTED（券商 API 是后续任务）。
 *
 * 合规（README 铁律 #5）：腾讯公共行情端点，无 key、无官方授权；个人使用边界自负
 * （详见 src/rest.ts 头注与 README 数据源节）。
 *
 * @module @dsh-trading/connector-tencent
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type { Disposable, Interval, Kline, MarketDataService, Ticker } from '@dsh-trading/api'
import {
  INTERVAL_VOCABULARY,
  type TencentMarket,
  type TencentRestOptions,
  type TencentTicker,
  TencentRestClient,
  TradingServiceError,
  normalizeSymbol,
} from './rest.js'

export * from './rest.js'

/**
 * Cordis 插件名：`dsh-trading-*` 命名空间（TEMPLATES §8）。**两个 preset 实例共享此
 * 插件名**——实例区分靠 preset 行 id（dsh-trading-cn-connector / dsh-trading-hk-connector）
 * 与 config.market，不再依赖插件名后缀（单包双市场与 crypto/us 的「一市场一插件名」不同）。
 */
export const name = 'dsh-trading-tencent'

export type MarketOption = TencentMarket

export interface Config {
  /** 市场分流（单包双市场的核心开关）：cn = A 股，hk = 港股。 */
  market: MarketOption
  /** 交易安全闸门（铁律 #3）：true 时下单类工具强制 dry-run。 */
  dryRun: boolean
  /** 实盘总闸门：默认 false；false 时无论 dryRun 与否都拒绝实盘下单 [S4]。 */
  liveTrading: boolean
}

export const Config: Schema<Config> = Schema.object({
  market: Schema.union(['cn', 'hk']).required(),
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
})

/** 需要宿主提供的 Cordis 服务。 */
export const inject = ['tools']

/* ------------------------------------------------------------------ */
/* 服务键（按实例分流；api 包 Context 模块增强声明了两个键）                    */
/* ------------------------------------------------------------------ */

export const TRADING_CN_MARKET_DATA_KEY = 'tradingCnMarketData'
export const TRADING_HK_MARKET_DATA_KEY = 'tradingHkMarketData'

export function marketDataKey(market: MarketOption): string {
  return market === 'hk' ? TRADING_HK_MARKET_DATA_KEY : TRADING_CN_MARKET_DATA_KEY
}

export interface SubscribeTickerOptions {
  /** 轮询间隔（ms）。subscribeTicker 以快照轮询实现（腾讯公共端点无推送面）。 */
  readonly intervalMs?: number
}

const SUBSCRIBE_MIN_MS = 250
const SUBSCRIBE_DEFAULT_MS = 5_000

export class TencentMarketDataService extends Service implements MarketDataService {
  // TS 编译期 private 而非 ECMAScript #（cordis realm 代理按类身份炸，README 定稿 5）。
  private readonly client: TencentRestClient

  constructor(
    ctx: Context,
    market: MarketOption,
    options: TencentRestOptions = {},
    name: string = TRADING_CN_MARKET_DATA_KEY,
  ) {
    super(ctx, name)
    this.client = new TencentRestClient(market, options)
  }

  getTicker(symbol: string): Promise<TencentTicker> {
    return this.client.getTicker(symbol)
  }

  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
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
/* <market>_place_order（交易安全闸门：铁律 #3 修订版 [S4]，三路径照抄 crypto/us） */
/* ------------------------------------------------------------------ */

/** <market>_place_order 参数契约（dryRun 缺省 true）。 */
export interface PlaceOrderArgs {
  /** A 股 6 位代码（600519/SH600519）或港股 1-5 位代码（00700/700）。 */
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

/** 闸门判定结果（三条路径与裁决顺序与 crypto/us 同构）。 */
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
        `${config.market}_place_order rejected: the call requests real execution (dryRun=${String(args.dryRun)}) `
        + 'but live trading is disabled (liveTrading=false). Ask the user to enable liveTrading explicitly '
        + 'after confirmation, or keep dryRun=true for a simulated fill.',
    }
  }
  if (requestedDryRun || config.dryRun) return { action: 'simulate' }
  return { action: 'live' }
}

/** 参数校验（模型调用问题抛普通 Error；服务故障才用错误词汇）。 */
function validatePlaceOrderArgs(market: MarketOption, args: PlaceOrderArgs): void {
  try {
    normalizeSymbol(market, args.symbol)
  } catch (cause) {
    const expected = market === 'hk' ? 'an HK code like 00700 or 700' : 'a CN A-share code like 600519 or SH600519'
    throw new Error(`${market}_place_order: invalid symbol ${JSON.stringify(args.symbol)} — expected ${expected}`, { cause })
  }
  if (args.side !== 'BUY' && args.side !== 'SELL') {
    throw new Error(`${market}_place_order: invalid side ${JSON.stringify(args.side)} — expected BUY or SELL`)
  }
  if (args.type !== 'MARKET' && args.type !== 'LIMIT') {
    throw new Error(`${market}_place_order: invalid type ${JSON.stringify(args.type)} — expected MARKET or LIMIT`)
  }
  if (typeof args.quantity !== 'number' || !Number.isFinite(args.quantity) || args.quantity <= 0) {
    throw new Error(`${market}_place_order: invalid quantity ${JSON.stringify(args.quantity)} — expected a positive number`)
  }
  if (args.type === 'LIMIT' && (typeof args.price !== 'number' || !Number.isFinite(args.price) || args.price <= 0)) {
    throw new Error(`${market}_place_order: LIMIT orders require a positive price`)
  }
}

function normalizePlaceOrderArgs(raw: unknown): PlaceOrderArgs {
  const args = (raw ?? {}) as PlaceOrderArgs
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : (undefined as unknown as string)
  return { ...args, symbol }
}

/** DRY-RUN 回执：模拟成交 + 腾讯最新行情参照（参照取不到不阻断模拟本身）。 */
export async function buildDryRunReceipt(
  market: MarketOption,
  args: PlaceOrderArgs,
  marketData: Pick<MarketDataService, 'getTicker'>,
): Promise<string> {
  const symbol = normalizeSymbol(market, args.symbol)
  let reference: Record<string, unknown>
  try {
    const ticker = await marketData.getTicker(symbol)
    reference = {
      source: 'tencent-quote',
      price: ticker.price,
      volume: ticker.volume,
      timestamp: ticker.timestamp,
    }
  } catch (error) {
    // 模拟单不因参照行情失败而失败：明确标注 unavailable 即可。
    reference = {
      source: 'tencent-quote',
      unavailable: error instanceof Error ? error.message : String(error),
    }
  }
  return JSON.stringify({
    status: 'filled',
    dryRun: true,
    note:
      'DRY-RUN — simulated fill; no order was sent to any broker. Tencent is a data source only (no trading API); '
      + 'the reference price is the latest public quote snapshot.',
    id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    market,
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
  /** 插件配置（market 分流 + dryRun 强制模拟 / liveTrading 总闸门）。 */
  readonly config: Config
}

/**
 * <market>_place_order 工具工厂（独立导出便于单测三条闸门路径）。
 *
 * 审批不在这里做：dryRun!==true 的调用由 @dsh-trading/base 的 gate 插件在
 * `tools/pre-execute` waterfall 统一 ask（S4：headless 下 ask=deny，fail-closed）。
 */
export function createPlaceOrderTool(deps: PlaceOrderToolDeps) {
  const market = deps.config.market
  return defineTool({
    name: `${market}_place_order`,
    description:
      `Place a ${market === 'hk' ? 'Hong Kong' : 'China A-share'} stock order, or simulate one. dryRun defaults to true and returns a DRY-RUN `
      + 'simulated fill receipt referencing the latest Tencent public quote. Real execution (dryRun=false) requires the '
      + 'plugin liveTrading switch plus user approval, and is not implemented yet in this slice (Tencent has no trading API).',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: market === 'hk'
          ? 'HK stock code, e.g. 00700 or 700 (normalized internally)'
          : 'CN A-share code, e.g. 600519 / SH600519 / sz000001 (normalized internally)',
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
      validatePlaceOrderArgs(market, args)

      const verdict = evaluateOrderGate(deps.config, args)
      if (verdict.action === 'reject') {
        // 闸门 ①：结构化拒绝，不抛异常（模型可直接读到原因与出路）。
        return JSON.stringify({ status: 'rejected', code: verdict.code, message: verdict.message })
      }
      if (verdict.action === 'simulate') {
        // 闸门 ②：模拟成交回执（DRY-RUN 标记 + 最新行情参照）。
        return buildDryRunReceipt(market, args, deps.marketData)
      }
      // 闸门 ③：实盘执行未实现（腾讯无交易 API；券商下单是后续任务）。
      throw new TradingServiceError(
        'TRADING_NOT_IMPLEMENTED',
        `${market}_place_order: live order execution is not implemented in this slice — Tencent provides market data only; `
        + 'a broker API is a follow-up. Keep dryRun=true for simulated fills.',
      )
    },
  })
}

export function apply(ctx: Context, config: Config): void {
  const market = config.market
  const key = marketDataKey(market)

  // provide：Service 基类随插件 fiber 注册，插件卸载自动注销；服务键按实例分流
  // （同包双实例互不冲突：cn 实例写 tradingCnMarketData，hk 实例写 tradingHkMarketData）。
  new TencentMarketDataService(ctx, market, {}, key)

  // inject：等本实例行情服务就绪后注册工具；工具只面向服务接口，不直连 HTTP。
  ctx.inject([key], (ctx) => {
    const marketData: MarketDataService = (ctx as unknown as Record<string, MarketDataService>)[key]

    ctx.tools.register(
      defineTool({
        name: `${market}_get_ticker`,
        description:
          `Get the latest market snapshot for a ${market === 'hk' ? 'Hong Kong (HKEX)' : 'China A-share'} stock via the `
          + 'Tencent public quote endpoint (qt.gtimg.cn). Returns price, open/high/low, prev close, volume (shares) and '
          + 'quote time. No credentials required; Tencent public endpoint, no official authorization — personal use at '
          + 'your own discretion per Tencent terms.',
        parameters: {
          symbol: {
            type: 'string',
            required: true,
            description: market === 'hk'
              ? 'HK stock code, e.g. 00700 or 700 (normalized internally)'
              : 'CN A-share code, e.g. 600519 / SH600519 / sz000001 (normalized internally)',
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
        name: `${market}_get_klines`,
        description:
          `Get recent OHLCV candles for a ${market === 'hk' ? 'Hong Kong (HKEX)' : 'China A-share'} stock via the Tencent `
          + 'public kline endpoint (cn supports 5m/30m/1d/1w/1M; hk supports 1d/1w/1M forward-adjusted qfq). '
          + 'No credentials required; Tencent public endpoint, no official authorization — personal use at your own discretion per Tencent terms.',
        parameters: {
          symbol: {
            type: 'string',
            required: true,
            description: market === 'hk'
              ? 'HK stock code, e.g. 00700 or 700 (normalized internally)'
              : 'CN A-share code, e.g. 600519 / SH600519 / sz000001 (normalized internally)',
          },
          interval: {
            type: 'string',
            enum: INTERVAL_VOCABULARY,
            description: 'Kline interval (Tencent-supported subset)',
            default: '1d',
          },
          limit: {
            type: 'integer',
            description: 'Number of most recent candles to return (1-800)',
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
