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
import { createGetIndicatorsTool } from '@dsh-trading/indicators/tool'
import type { Disposable, Interval, Kline, MarketDataService, Ticker } from '@dsh-trading/api'
import { BinanceRestClient, INTERVAL_VOCABULARY, TradingServiceError } from './rest.js'
import type { BinanceRestOptions } from './rest.js'

interface ToolsServiceLike {
  register(definition: { name: string }): unknown
  get(name: string): { name: string } | undefined
}

/**
 * 互斥激活的注册面（与 connector-okx 的 registerTool 同款，2026-08-31 补齐）：
 * dsh-tools 对同名重复注册直接抛错，互斥纪律下冲突降级为「先到先得 + warn」。
 * 没有这层时，inject 回调就绪顺序不定会让同名工具（含 crypto_get_indicators）
 * 在两 connector 同树时随机炸挂载——activation.test 曾因此竞态翻车。
 */
function registerTool(ctx: Context, tool: ReturnType<typeof defineTool>, log: LogLike): void {
  const tools = ctx.tools as unknown as ToolsServiceLike
  if (tools.get(tool.name) !== undefined) {
    log.warn(
      '[dsh-trading-crypto-connector-binance] tool %s already registered by another provider — skipped (mutual exclusion: at most one crypto connector/toolset may be active)',
      tool.name,
    )
    return
  }
  tools.register(tool)
}

export * from './rest.js'

/**
 * Cordis 插件名 = patch 行 id（TEMPLATES §8）：`dsh-trading-crypto-*` 市场命名空间，
 * 全仓唯一，绝不使用 `base` 等官方保留 id（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-crypto-connector-binance'

export interface Config {
  /** 互斥激活总开关（默认 true）：false 时本插件不注册任何服务/工具（okx 行启用时须关本开关；docs/okx-integration.md §8.2 方案 B）。 */
  enabled: boolean
  /** 交易安全闸门（铁律 #3）：true 时下单类工具强制 dry-run。 */
  dryRun: boolean
  /** 实盘总闸门：默认 false；false 时无论 dryRun 与否都拒绝实盘下单 [S4]。 */
  liveTrading: boolean
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
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
  // 用 TS 编译期 private 而非 ECMAScript # 私有字段：cordis 跨 realm 的 context
  // 访问可能经代理/包装，# 字段按类身份校验会在合法调用上炸
  // （「Cannot read private member」）；官方包同用 TS private（acceptance 验收发现）。
  private readonly client: BinanceRestClient

  constructor(ctx: Context, options: BinanceRestOptions = {}, name: string = TRADING_CRYPTO_MARKET_DATA_KEY) {
    super(ctx, name)
    this.client = new BinanceRestClient(options)
  }

  getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
  }

  listInstruments(): Promise<Array<{ symbol: string; name?: string }>> {
    return this.client.listInstruments()
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
/* 工具注册（经服务执行）                                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* crypto_place_order（交易安全闸门：铁律 #3 修订版 [S4]）                  */
/* ------------------------------------------------------------------ */

/** crypto_place_order 参数契约（本切片词汇：Binance 现货下单参数，dryRun 缺省 true）。 */
export interface PlaceOrderArgs {
  /** 交易对符号，如 `BTCUSDT`（执行前归一化为大写）。 */
  readonly symbol: string
  /** 方向（交易所词汇大写）。 */
  readonly side: 'BUY' | 'SELL'
  /** 订单类型（交易所词汇大写）。 */
  readonly type: 'MARKET' | 'LIMIT'
  /** base 资产数量，必须 > 0。 */
  readonly quantity: number
  /** LIMIT 单必填（schema 无法条件必填，execute 内校验），必须 > 0。 */
  readonly price?: number
  /** 缺省视为 true：仅模拟。显式 false 即实盘意图，进入闸门 ①/③。 */
  readonly dryRun?: boolean
}

/**
 * 闸门判定结果（三条路径，顺序即铁律 #3 修订版的裁决顺序）：
 *  - `reject`  —— ① 请求实盘（dryRun!==true）而 liveTrading=false：工具返回结构化
 *                拒绝（不抛异常，模型可读到明确原因与出路）；
 *  - `simulate` —— ② dryRun=true（显式、缺省，或被插件 config.dryRun 强制）：
 *                返回 DRY-RUN 模拟成交回执；
 *  - `live`    —— ③ dryRun=false 且 liveTrading=true：本切片无签名下单能力，
 *                工具抛 TRADING_NOT_IMPLEMENTED 结构化错误。
 *
 * 优先级说明：config.dryRun=true 是「强制模拟」开关，只影响 ②/③ 的归类；
 * 显式 dryRun=false 的实盘意图在 liveTrading=false 时仍走 ① 明确拒绝，
 * 不做静默降级（拒绝语义优先于强制模拟，调用方必须知道实盘意图被拒）。
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
        `crypto_place_order rejected: the call requests real execution (dryRun=${String(args.dryRun)}) `
        + 'but live trading is disabled (liveTrading=false). Ask the user to enable liveTrading explicitly '
        + 'after confirmation, or keep dryRun=true for a simulated fill.',
    }
  }
  if (requestedDryRun || config.dryRun) return { action: 'simulate' }
  return { action: 'live' }
}

/** Binance 现货符号形如 BTCUSDT / ETHUSDT：大写字母数字（kit 同款词汇）。 */
const SPOT_SYMBOL_PATTERN = /^[A-Z0-9]{4,20}$/

/** 参数校验（模型调用问题抛普通 Error，与 kit 先例一致；服务故障才用错误词汇）。 */
function validatePlaceOrderArgs(args: PlaceOrderArgs): void {
  if (!SPOT_SYMBOL_PATTERN.test(args.symbol)) {
    throw new Error(`crypto_place_order: invalid symbol ${JSON.stringify(args.symbol)} — expected an uppercase Binance symbol like BTCUSDT`)
  }
  if (args.side !== 'BUY' && args.side !== 'SELL') {
    throw new Error(`crypto_place_order: invalid side ${JSON.stringify(args.side)} — expected BUY or SELL`)
  }
  if (args.type !== 'MARKET' && args.type !== 'LIMIT') {
    throw new Error(`crypto_place_order: invalid type ${JSON.stringify(args.type)} — expected MARKET or LIMIT`)
  }
  if (typeof args.quantity !== 'number' || !Number.isFinite(args.quantity) || args.quantity <= 0) {
    throw new Error(`crypto_place_order: invalid quantity ${JSON.stringify(args.quantity)} — expected a positive number`)
  }
  if (args.type === 'LIMIT' && (typeof args.price !== 'number' || !Number.isFinite(args.price) || args.price <= 0)) {
    throw new Error('crypto_place_order: LIMIT orders require a positive price')
  }
}

function normalizePlaceOrderArgs(raw: unknown): PlaceOrderArgs {
  const args = (raw ?? {}) as PlaceOrderArgs
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim().toUpperCase() : (undefined as unknown as string)
  return { ...args, symbol }
}

/** DRY-RUN 回执：模拟成交 + 当前市价参照（参照取不到不阻断模拟本身）。 */
export interface DryRunReference {
  source: 'binance-public-ticker'
  price?: number
  bid?: number
  ask?: number
  timestamp?: number
  unavailable?: string
}

export async function buildDryRunReceipt(
  args: PlaceOrderArgs,
  marketData: Pick<MarketDataService, 'getTicker'>,
): Promise<string> {
  let reference: DryRunReference
  try {
    const ticker = await marketData.getTicker(args.symbol)
    reference = {
      source: 'binance-public-ticker',
      price: ticker.price,
      bid: ticker.bid,
      ask: ticker.ask,
      timestamp: ticker.timestamp,
    }
  } catch (error) {
    // 模拟单不因参照行情失败而失败：明确标注 unavailable 即可。
    reference = {
      source: 'binance-public-ticker',
      unavailable: error instanceof Error ? error.message : String(error),
    }
  }
  return JSON.stringify({
    status: 'filled',
    dryRun: true,
    note: 'DRY-RUN — simulated fill; no order was sent to any exchange. The reference price is market data only, not a fill price.',
    id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: args.symbol,
    side: args.side.toLowerCase(),
    type: args.type.toLowerCase(),
    quantity: args.quantity,
    ...(args.type === 'LIMIT' ? { price: args.price } : {}),
    reference,
    timestamp: Date.now(),
  })
}

export interface PlaceOrderToolDeps {
  /** 行情服务（ dry-run 回执的市价参照），按接口取用，不直连 REST。 */
  readonly marketData: Pick<MarketDataService, 'getTicker'>
  /** 插件配置（dryRun 强制模拟 / liveTrading 总闸门）。 */
  readonly config: Config
}

/**
 * crypto_place_order 工具工厂（独立导出便于单测三条闸门路径）。
 *
 * 审批不在这里做：dryRun!==true 的调用由 @dsh-trading/base 的 gate 插件在
 * `tools/pre-execute` waterfall 统一 ask（S4：headless 下 ask=deny，fail-closed）；
 * 工具内不再重复调 ctx.approval。
 */
export function createPlaceOrderTool(deps: PlaceOrderToolDeps) {
  return defineTool({
    name: 'crypto_place_order',
    description:
      'Place a Binance spot order, or simulate one. dryRun defaults to true and returns a DRY-RUN simulated fill receipt with the current market price as reference. Real execution (dryRun=false) requires the plugin liveTrading switch to be enabled plus user approval, and is not implemented yet in this slice.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'Trading pair symbol, e.g. BTCUSDT',
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
        description: 'Base asset quantity, must be > 0',
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
        // 闸门 ②：模拟成交回执（DRY-RUN 标记 + 市价参照）。
        return buildDryRunReceipt(args, deps.marketData)
      }
      // 闸门 ③：实盘执行未实现（签名下单是后续任务）；结构化错误词汇回给模型。
      throw new TradingServiceError(
        'TRADING_NOT_IMPLEMENTED',
        'crypto_place_order: live order execution is not implemented in this slice — signed order placement (credentials + exchange endpoint) is a follow-up task. Keep dryRun=true for simulated fills.',
      )
    },
  })
}

/** 宿主 logger 的最小形状（ctx.logger(name) 不可用时回落 console，保证任何面可启动）。 */
interface LogLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

function logger(ctx: Context): LogLike {
  const service = (ctx as unknown as { logger?: (name: string) => LogLike }).logger
  return typeof service === 'function' ? service(name) : console
}

/** 本连接器的路由 provider slug（docs/exchange-routing.md §2.2：路由层词汇，非包名）。 */
export const ROUTER_PROVIDER = 'binance'

/** 市场路由服务的最小消费面（api 包 MarketRouterService 同构；不定死接口）。 */
export interface MarketRouterLike {
  activeProvider(market: string): string | undefined
}

/**
 * 路由裁决（2026-08-29 设置驱动重构）：router 存在且给本市场选了别的 provider →
 * 本连接器静默退出（设置是权威）；router 不存在（老部署）→ 回退 enabled 语义。
 * 返回 true = 应继续 apply。
 */
export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as MarketRouterLike | undefined
  if (router === undefined) return true // 无 router：enabled 语义（向后兼容）
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  const log = logger(ctx)

  // 互斥激活：false（配合 okx 行启用）时静默退出，不注册任何东西。
  if (!config.enabled) {
    log.info(
      '[dsh-trading-crypto-connector-binance] not activated (enabled=false) — tradingCryptoMarketData and crypto_* tools stay unregistered; market data comes from the other active connector',
    )
    return
  }

  // 市场路由裁决（2026-08-29）：设置选了别的 provider → 静默退出（不是配置错，是路由）。
  const router = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as MarketRouterLike | undefined
  const active = router?.activeProvider('crypto')
  if (router !== undefined && active !== ROUTER_PROVIDER) {
    log.info(
      '[dsh-trading-crypto-connector-binance] market router selects %s for crypto — not activated; set dshtrading.markets.crypto.provider to binance to use this connector',
      String(active ?? '(unset)'),
    )
    return
  }

  // provide：Service 基类随插件 fiber 注册，插件卸载自动注销。
  new BinanceMarketDataService(ctx)

  // inject：等行情服务就绪后注册工具；工具只面向服务接口，不直连 REST。
  ctx.inject(['tradingCryptoMarketData'], (ctx) => {
    const marketData = ctx.tradingCryptoMarketData
    // duplicate-safe 注册（与 connector-okx 同款仲裁）：同名先到先得 + warn。
    const register = (tool: ReturnType<typeof defineTool>) => registerTool(ctx, tool, log)

    // WS1b（docs/analysis-roadmap.md #2）：指标计算工具——共享工厂，K 线走本 connector
    // 行情服务（路由选中的数据源），计算走 @dsh-trading/indicators。
    register(createGetIndicatorsTool({ marketData, providerLabel: 'binance' }))

    register(
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

    register(
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

    // 交易安全闸门（铁律 #3 修订版 [S4]）：三条路径见 evaluateOrderGate；
    // dryRun!==true 的审批由 base 的 gate 插件统一在 pre-execute 承担。
    register(
      createPlaceOrderTool({ marketData, config }),
    )
  })
}
