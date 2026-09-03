/**
 * @dshtrading/strategies/plugin —— 策略 Agent 产出管线 host 半插件
 * （issue #31 / P2，dataplane 行同款先例：subpath 插件模块）。
 *
 * patch 行：id `dsh-trading-strategies` / name `@dshtrading/strategies/plugin`
 * （base 拥有该共享行——策略引擎市场无关，铁律 #4）。
 *
 * 职责：
 * - `strategy_author`：提交 → 结构/语法/试算/信号序列校验（vm 熔断）→ 落盘
 *   ~/.dsh/strategies/custom.json（tmp+rename 原子写）；写后 emit tradingEvents('strategies')。
 * - `strategy_backtest`：对策略（自定义 ∪ 6 大范式）+ 标的 + 周期跑纯函数引擎 run()，
 *   返回 8 指标 + 交易流水 + 净值曲线。host 平面注册，全会话可见（owner 裁决 D4）。
 *
 * 红线（铁律 #3）：策略层永不触发 place_order——本插件只读行情 + 本地回测。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import os from 'node:os'
import path from 'node:path'
import type { MarketDataService } from '@dshtrading/api'
import { getStrategyById, run } from './index.ts'
import { createFileCustomStrategyStore } from './custom-fs.ts'
import type { CustomStrategyRecord, CustomStrategyStore } from './custom.ts'

// 桥（client-ui-trading node 半）经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileCustomStrategyStore }
import { compileStrategySource } from './validate.ts'
import { validateCustomStrategyNode } from './validate-node.ts'
import type { BacktestResult, StrategyDefinition, StrategyHorizon, StrategyParamSpec } from './types.ts'

/** Cordis 插件名 = patch 行 id（TEMPLATES §8），市场无关共享行命名空间。 */
export const name = 'dsh-trading-strategies'

/** 本插件不硬依赖任何服务（headless 宿主零要求）；tools/注册表经 ctx.inject 声明。 */
export const inject: string[] = []

/** 行情服务键映射（与 client-ui-trading/bridge 的 MARKET_SERVICE_KEYS 同词汇；本地副本避免跨包依赖）。 */
const MARKET_SERVICE_KEYS: Record<string, string> = {
  crypto: 'tradingCryptoMarketData',
  us: 'tradingUsMarketData',
  cn: 'tradingCnMarketData',
  hk: 'tradingHkMarketData',
}

/** 默认存储路径：~/.dsh/strategies/custom.json。 */
export function defaultStorePath(): string {
  return path.join(os.homedir(), '.dsh', 'strategies', 'custom.json')
}

/** tradingEvents 的最小发布面（鸭式，不定死接口；总线缺席时静默降级）。 */
export interface TradingEventsPublisher {
  emit(store: 'strategies'): void
}

function eventsOf(ctx: Context): TradingEventsPublisher | undefined {
  return (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingEvents', false) as TradingEventsPublisher | undefined
}

/** 注册表 + 老部署回退的行情解析面（与桥同款 registry-first 语义）。 */
export interface StrategyMarketDataResolver {
  (market: string): MarketDataService | undefined
}

export function createMarketDataResolver(ctx: Context): StrategyMarketDataResolver {
  return (market: string) => {
    const registry = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false) as
      | { active(m: string): { service: MarketDataService } | undefined }
      | undefined
    if (registry !== undefined) {
      return registry.active(market)?.service
    }
    // 老部署回退：市场键直读（无 router/registry 的旧宿主）。
    const key = MARKET_SERVICE_KEYS[market]
    return key === undefined ? undefined : (ctx as unknown as { get?: (k: string) => unknown }).get?.(key) as MarketDataService | undefined
  }
}

export interface StrategyAuthorToolOptions {
  store: CustomStrategyStore
  /** 可选：策略成功落盘后的回调（issue #30：事件总线 emit('strategies') 接线点）。 */
  onWritten?: (record: CustomStrategyRecord) => void
}

/** strategy_author 工厂（独立导出便于单测）。 */
export function createStrategyAuthorTool(options: StrategyAuthorToolOptions) {
  const { store, onWritten } = options
  return defineTool({
    name: 'strategy_author',
    description:
      'Author, validate, and persist a custom trading strategy from JavaScript compute source. '
      + 'compute(bars, params) must return StrategySignal[] (entry/exit at bar close, filled at next bar open by the backtest engine). '
      + 'The validator runs sandbox trial calculations across multiple kline scenarios and replays the signal sequence for engine-replayability. '
      + 'If valid, the strategy is persisted and immediately available for backtesting and the strategy roster.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Unique strategy id (2-32 chars: lowercase letters/digits/underscore/hyphen, e.g. "ema-stop-takeprofit"); the 6 built-in paradigm ids are reserved',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Display name (1-32 chars), e.g. "双均线止损止盈"',
      },
      horizon: {
        type: 'string',
        required: true,
        description: 'Strategy horizon: "short" (短线), "swing" (波段), or "long" (长线)',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'One-sentence idea summary (≤120 chars), shown in the roster and chat card',
      },
      paramsJson: {
        type: 'string',
        description:
          'JSON string of StrategyParamSpec[] (optional, default []). Each spec: { key, label, default, min, max } with numeric default/min/max and min < max. JSON example: [{"key":"fast","label":"fast EMA","default":20,"min":2,"max":120}]',
      },
      computeSource: {
        type: 'string',
        required: true,
        description:
          'JavaScript pure function source, signature (bars, params) => StrategySignal[]. '
          + 'bars has { openTime, open, high, low, close, volume }. Each signal: { index, time, action: "entry"|"exit", direction: "long"|"flat", price: bars[index].close, reason }. '
          + 'Signals must be strictly index-increasing, start with entry, and alternate entry/exit.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const candidate: CustomStrategyRecord = {
        id: typeof args.id === 'string' ? args.id : '',
        title: typeof args.title === 'string' ? args.title : '',
        horizon: (typeof args.horizon === 'string' ? args.horizon : '') as StrategyHorizon,
        summary: typeof args.summary === 'string' ? args.summary : '',
        paramsJson: typeof args.paramsJson === 'string' && args.paramsJson.trim() ? args.paramsJson.trim() : '[]',
        computeSource: typeof args.computeSource === 'string' ? args.computeSource : '',
        createdAt: Date.now(),
      }

      const result = await validateCustomStrategyNode(candidate)
      if (!result.ok) {
        return (
          `[strategy_author] Validation failed: ${result.reason}\n`
          + 'Review the requirements: compute(bars, params) returns StrategySignal[]; each signal confirms at bar close '
          + '(price === bars[index].close, time === bars[index].openTime), indices strictly increase, the sequence starts with entry '
          + 'and strictly alternates entry/exit (the engine fills at the next bar\'s open).'
        )
      }

      await store.save(result.record)
      onWritten?.(result.record)

      const specSummary = result.definition.params.map(p => `${p.key}=${p.default}`).join(', ')
      return (
        `[strategy_author] Successfully authored strategy "${result.record.title}" (id: ${result.record.id}, horizon: ${result.record.horizon}${specSummary ? `, params: ${specSummary}` : ''}). `
        + 'The strategy passed sandbox trials across 5 kline scenarios with engine-replayable signal sequences and is now persisted — '
        + 'call strategy_backtest with this id to backtest it.'
      )
    },
  })
}

export interface StrategyBacktestToolOptions {
  store: CustomStrategyStore
  marketData: StrategyMarketDataResolver
}

/** 自定义或范式策略 → 回测用 StrategyDefinition（自定义 compute 经编译落定）。 */
export async function resolveStrategyDefinition(store: CustomStrategyStore, strategyId: string): Promise<StrategyDefinition | undefined> {
  const record = await store.get(strategyId)
  if (record !== undefined) {
    let params: StrategyParamSpec[] = []
    try {
      const parsed = JSON.parse(record.paramsJson) as StrategyParamSpec[]
      if (Array.isArray(parsed)) params = parsed
    } catch {
      params = []
    }
    return {
      id: record.id,
      horizon: record.horizon,
      name: record.title,
      summary: record.summary,
      params,
      compute: compileStrategySource(record.computeSource),
    }
  }
  return getStrategyById(strategyId)
}

export interface StrategyBacktestToolDeps {
  store: CustomStrategyStore
  marketData: StrategyMarketDataResolver
}

/** strategy_backtest 工厂（独立导出便于单测）。 */
export function createStrategyBacktestTool(deps: StrategyBacktestToolDeps) {
  return defineTool({
    name: 'strategy_backtest',
    description:
      'Backtest a strategy (custom authored via strategy_author, or a built-in paradigm like ema-crossover / donchian-breakout '
      + '/ rsi-reversion / bollinger-reversion / sma-baseline / momentum-12m) on a symbol and interval using the pure-function engine. '
      + 'Returns 8 metrics (totalReturn, cagr, maxDrawdown, sharpe, winRate, profitFactor, tradeCount, exposure), the trade list, and the equity curve. '
      + 'Signals confirm at bar close and fill at the next bar open with fee/slippage modeling; this is simulation only — it never places orders.',
    parameters: {
      strategyId: {
        type: 'string',
        required: true,
        description: 'Strategy id — a custom id from strategy_author or a built-in paradigm id',
      },
      market: {
        type: 'string',
        required: true,
        description: 'Market vocabulary: crypto | us | cn | hk',
      },
      symbol: {
        type: 'string',
        required: true,
        description: 'Market-canonical symbol, e.g. BTCUSDT (crypto), AAPL (us), 600519.SH (cn), 00700.HK (hk)',
      },
      interval: {
        type: 'string',
        description: 'Kline interval (default "1d"), e.g. 1m/5m/15m/1h/4h/1d/1w/1M — subject to the market data provider vocabulary',
      },
      limit: {
        type: 'number',
        description: 'Kline count to backtest (default 200, capped by the provider)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const strategyId = typeof args.strategyId === 'string' ? args.strategyId.trim() : ''
      const market = typeof args.market === 'string' ? args.market.trim() : ''
      const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : ''
      const interval = typeof args.interval === 'string' && args.interval.trim() ? args.interval.trim() : '1d'
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.floor(args.limit), 1000)
        : 200

      if (!strategyId || !market || !symbol) {
        throw new Error('strategy_backtest: strategyId, market and symbol are required')
      }

      const definition = await resolveStrategyDefinition(deps.store, strategyId)
      if (definition === undefined) {
        throw new Error(
          `strategy_backtest: unknown strategyId "${strategyId}" — author one with strategy_author first, or use a built-in paradigm id `
          + '(donchian-breakout, rsi-reversion, ema-crossover, bollinger-reversion, sma-baseline, momentum-12m)',
        )
      }

      const service = deps.marketData(market)
      if (service === undefined) {
        throw new Error(`strategy_backtest: no market data service for market "${market}" — install/activate a market connector first`)
      }
      const bars = await service.getKlines(symbol, interval, limit)
      if (!Array.isArray(bars) || bars.length === 0) {
        throw new Error(`strategy_backtest: no klines returned for ${symbol} (${market}, ${interval}) — check the symbol/interval vocabulary`)
      }

      const result: BacktestResult = run(bars, definition)
      return JSON.stringify({
        ok: true,
        strategy: { id: definition.id, name: definition.name, horizon: definition.horizon },
        market,
        symbol,
        interval,
        barsTested: bars.length,
        metrics: result.metrics,
        trades: result.trades,
        equity: result.equity,
        initialCapital: result.initialCapital,
        finalCapital: result.finalCapital,
      })
    },
  })
}

/** Host plugin body：注册 strategy_author / strategy_backtest（host 平面，全会话可见）。 */
export function apply(ctx: Context): void {
  const store = createFileCustomStrategyStore(defaultStorePath())

  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (!tools || typeof tools.register !== 'function') return

    const authorTool = createStrategyAuthorTool({
      store,
      onWritten: () => eventsOf(ctx)?.emit('strategies'),
    })
    if (tools.get(authorTool.name) === undefined) {
      tools.register(authorTool)
    }

    const backtestTool = createStrategyBacktestTool({ store, marketData: createMarketDataResolver(ctx) })
    if (tools.get(backtestTool.name) === undefined) {
      tools.register(backtestTool)
    }
  })
}
