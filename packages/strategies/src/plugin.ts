/**
 * @dshtrading/strategies/plugin —— 策略 Agent 产出管线 host 半插件
 * （issue #31 / P2，dataplane 行同款先例：subpath 插件模块）。
 *
 * patch 行：id `dsh-trading-strategies` / name `@dshtrading/strategies/plugin`
 * （base 拥有该共享行——策略引擎市场无关，铁律 #4）。
 *
 * 职责：
 * - provide `tradingStrategies` 服务（file store 单实例：桥与工具共享同一缓存）。
 * - `strategy_author`：提交 → 结构/语法/试算/信号序列校验（vm 熔断）→ 落盘
 *   ~/.dsh/strategies/custom.json（tmp+rename 原子写）；写后 emit tradingEvents('strategies')。
 *   同 id 再提交即覆盖；id 为内置范式 → 覆盖该内置策略（策略管理，2026-09-07）。
 * - `strategy_delete` / `strategy_reset`：删除（自定义移除 / 内置落墓碑）与
 *   恢复出厂（清覆盖 + 墓碑），覆盖 + 墓碑模型见 management.ts。
 * - `strategy_backtest`：对策略（自定义 ∪ 6 大范式，经墓碑/覆盖合成）+ 标的
 *   + 周期跑纯函数引擎 run()，返回 8 指标 + 交易流水 + 净值曲线。
 *
 * 红线（铁律 #3）：策略层永不触发 place_order——本插件只读行情 + 本地回测。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import os from 'node:os'
import path from 'node:path'
import type { MarketDataService } from '@dshtrading/api'
import { getStrategyById, run } from './index.ts'
import { createFileCustomStrategyStore } from './custom-fs.ts'
import type { CustomStrategyRecord, CustomStrategyStore } from './custom.ts'
import { createFileBuiltinTombstonesStore } from './builtin-tombstones-fs.ts'
import type { BuiltinTombstonesStore } from './builtin-tombstones.ts'
import { isBuiltinStrategyId } from './management.ts'

// 桥（client-ui-trading node 半）经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileCustomStrategyStore }
export { createFileBuiltinTombstonesStore }
export { isBuiltinStrategyId } from './management.ts'
// 桥（node 半）保存策略前的落盘前校验入口（vm 熔断）。
export { validateCustomStrategyNode } from './validate-node.ts'
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

/** 默认墓碑路径：~/.dsh/strategies/builtin-tombstones.json（策略管理）。 */
export function defaultTombstonesStorePath(): string {
  return path.join(os.homedir(), '.dsh', 'strategies', 'builtin-tombstones.json')
}

/** SDK 服务键：自定义策略 store 单实例（桥与工具共享同一缓存）。 */
export const TRADING_STRATEGIES_KEY = 'tradingStrategies'

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
  /** 可选：墓碑表（覆盖内置 id 时顺带恢复删除标记，策略管理语义）。 */
  tombstones?: BuiltinTombstonesStore
  /** 可选：策略成功落盘后的回调（issue #30：事件总线 emit('strategies') 接线点）。 */
  onWritten?: (record: CustomStrategyRecord) => void
}

/** strategy_author 工厂（独立导出便于单测）。 */
export function createStrategyAuthorTool(options: StrategyAuthorToolOptions) {
  const { store, tombstones, onWritten } = options
  return defineTool({
    name: 'strategy_author',
    description:
      'Author, validate, and persist a custom trading strategy from JavaScript compute source. '
      + 'compute(bars, params) must return StrategySignal[] (entry/exit at bar close, filled at next bar open by the backtest engine). '
      + 'The validator runs sandbox trial calculations across multiple kline scenarios and replays the signal sequence for engine-replayability. '
      + 'If valid, the strategy is persisted and immediately available for backtesting and the strategy roster. '
      + 'Submitting an id equal to a built-in paradigm id (donchian-breakout / rsi-reversion / ema-crossover / bollinger-reversion / sma-baseline / momentum-12m) '
      + 'OVERRIDES that built-in strategy (the factory default stays recoverable via strategy_reset).',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Unique strategy id (2-32 chars: lowercase letters/digits/underscore/hyphen, e.g. "ema-stop-takeprofit"); a built-in paradigm id means overriding that built-in strategy',
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

      const overridesBuiltin = isBuiltinStrategyId(result.record.id)
      if (overridesBuiltin) {
        // 覆盖内置 = 恢复该 id 的删除标记（墓碑 + 覆盖并存无意义，author 即「要回它」）。
        await tombstones?.remove(result.record.id)
      }
      await store.save(result.record)
      onWritten?.(result.record)

      const specSummary = result.definition.params.map(p => `${p.key}=${p.default}`).join(', ')
      const scopeNote = overridesBuiltin
        ? 'This id is a built-in paradigm — the factory default remains recoverable via strategy_reset.'
        : 'Call strategy_backtest with this id to backtest it.'
      return (
        `[strategy_author] Successfully authored strategy "${result.record.title}" (id: ${result.record.id}, horizon: ${result.record.horizon}${specSummary ? `, params: ${specSummary}` : ''}). `
        + 'The strategy passed sandbox trials across 5 kline scenarios with engine-replayable signal sequences and is now persisted — '
        + scopeNote
      )
    },
  })
}

export interface StrategyBacktestToolOptions {
  store: CustomStrategyStore
  /** 可选：墓碑表（内置删除后回测拒绝并引导恢复，策略管理语义）。 */
  tombstones?: BuiltinTombstonesStore
  marketData: StrategyMarketDataResolver
}

/** 查询墓碑表（缺席或未命中 = 未删）。 */
async function isTombstoned(tombstones: BuiltinTombstonesStore | undefined, id: string): Promise<boolean> {
  if (tombstones === undefined) return false
  return (await tombstones.list()).includes(id)
}

/**
 * 自定义或范式策略 → 回测用 StrategyDefinition（自定义 compute 经编译落定）。
 * 覆盖 + 墓碑合成：store 同 id 记录优先（含内置覆盖）；墓碑命中的 id 一律
 * 视为不存在（含误留覆盖记录的边界——删除语义优先）。
 */
export async function resolveStrategyDefinition(
  store: CustomStrategyStore,
  strategyId: string,
  options?: { tombstones?: BuiltinTombstonesStore | undefined },
): Promise<StrategyDefinition | undefined> {
  if (await isTombstoned(options?.tombstones, strategyId)) return undefined
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
  tombstones?: BuiltinTombstonesStore
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

      const definition = await resolveStrategyDefinition(deps.store, strategyId, { tombstones: deps.tombstones })
      if (definition === undefined) {
        if (await isTombstoned(deps.tombstones, strategyId)) {
          throw new Error(
            `strategy_backtest: strategy "${strategyId}" has been deleted by the user — call strategy_reset with this id to restore `
            + 'the factory default, or strategy_author to re-create it.',
          )
        }
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

export interface StrategyDeleteToolOptions {
  store: CustomStrategyStore
  tombstones?: BuiltinTombstonesStore
  /** 可选：删除成功后的回调（emit('strategies') 接线点；幂等未命中也通知，GUI 对账无害）。 */
  onDeleted?: (id: string, scope: 'custom' | 'builtin', removed: boolean) => void
}

/**
 * strategy_delete 工厂（策略管理）：自定义策略 = 移除记录；内置范式 = 落墓碑
 * （出厂代码不动，strategy_reset 可恢复）。覆盖 + 墓碑模型见 management.ts。
 */
export function createStrategyDeleteTool(options: StrategyDeleteToolOptions) {
  const { store, tombstones, onDeleted } = options
  return defineTool({
    name: 'strategy_delete',
    description:
      'Delete a strategy by id. Custom strategies (authored via strategy_author) are removed from the library; '
      + 'built-in paradigm ids (donchian-breakout / rsi-reversion / ema-crossover / bollinger-reversion / sma-baseline / momentum-12m) '
      + 'are tombstoned instead — the built-in disappears from the roster and backtest but stays recoverable via strategy_reset. '
      + 'Deleting a built-in also discards any user override of it. The GUI strategy roster refreshes live over the SSE channel.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Strategy id to delete (a custom id or a built-in paradigm id)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { id?: unknown }
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) {
        throw new Error('strategy_delete: id is required')
      }
      if (isBuiltinStrategyId(id)) {
        await tombstones?.add(id)
        const discardedOverride = await store.remove(id)
        onDeleted?.(id, 'builtin', true)
        return JSON.stringify({
          ok: true,
          scope: 'builtin',
          deleted: true,
          discardedOverride,
          note: `Built-in strategy "${id}" is now tombstoned — hidden from the roster and backtest. Call strategy_reset to restore the factory default.`,
        })
      }
      const removed = await store.remove(id)
      onDeleted?.(id, 'custom', removed)
      return JSON.stringify({
        ok: true,
        scope: 'custom',
        deleted: removed,
        note: removed
          ? `Deleted custom strategy "${id}".`
          : `"${id}" was not found in the custom strategy library (built-in ids are handled by tombstone — double-check the id).`,
      })
    },
  })
}

export interface StrategyResetToolOptions {
  store: CustomStrategyStore
  tombstones?: BuiltinTombstonesStore
  /** 可选：恢复成功后的回调（emit('strategies') 接线点）。 */
  onReset?: (id: string, changed: boolean) => void
}

/**
 * strategy_reset 工厂（策略管理）：恢复内置策略出厂默认——清覆盖记录与墓碑。
 * 仅对内置范式 id 有意义；自定义策略无出厂版本，明确报错引导 strategy_delete。
 */
export function createStrategyResetTool(options: StrategyResetToolOptions) {
  const { store, tombstones, onReset } = options
  return defineTool({
    name: 'strategy_reset',
    description:
      'Restore a built-in paradigm strategy (donchian-breakout / rsi-reversion / ema-crossover / bollinger-reversion / sma-baseline / momentum-12m) '
      + 'to its factory default: any user override is discarded and a deletion tombstone is lifted. Custom strategy ids have no factory '
      + 'default — use strategy_delete for those.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Built-in paradigm strategy id to restore',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { id?: unknown }
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) {
        throw new Error('strategy_reset: id is required')
      }
      if (!isBuiltinStrategyId(id)) {
        throw new Error(
          `strategy_reset: "${id}" is not a built-in paradigm strategy id — custom strategies have no factory default; use strategy_delete to remove them`,
        )
      }
      const removedOverride = await store.remove(id)
      const liftedTombstone = await tombstones?.remove(id) ?? false
      const changed = removedOverride || liftedTombstone
      onReset?.(id, changed)
      return JSON.stringify({
        ok: true,
        reset: true,
        changed,
        removedOverride,
        liftedTombstone,
        note: changed
          ? `Built-in strategy "${id}" restored to factory default (override/tombstone cleared).`
          : `"${id}" was already at factory default — nothing to restore.`,
      })
    },
  })
}

/** Host plugin body：provide store 服务 + 注册策略工具族（host 平面，全会话可见）。 */
export function apply(ctx: Context): void {
  const store = createFileCustomStrategyStore(defaultStorePath())
  const tombstones = createFileBuiltinTombstonesStore(defaultTombstonesStorePath())
  // Service 单实例（issue #33 收口模式，同 indicators 的 tradingCustomIndicators）：
  // 桥（client-ui-trading node 半）经 ctx.get 解包 .store/.tombstones 复用同一
  // 实例——此前桥自建第二个 file store，工具写入与桥缓存互不感知（跨实例 stale 窗口）。
  new StrategiesStoreService(ctx, { store, tombstones })

  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (!tools || typeof tools.register !== 'function') return

    const events = () => eventsOf(ctx)?.emit('strategies')
    const register = (tool: ReturnType<typeof defineTool>) => {
      if (tools.get(tool.name) === undefined) tools.register(tool)
    }

    register(createStrategyAuthorTool({ store, tombstones, onWritten: () => events() }))
    register(createStrategyBacktestTool({ store, tombstones, marketData: createMarketDataResolver(ctx) }))
    register(createStrategyDeleteTool({ store, tombstones, onDeleted: () => events() }))
    register(createStrategyResetTool({ store, tombstones, onReset: () => events() }))
  })
}

/** 策略 store 服务（桥与工具的单实例共享点，issue #33 收口模式）。 */
export class StrategiesStoreService extends Service {
  readonly store: CustomStrategyStore
  /** 内置墓碑表（策略管理；桥 DELETE/POST /strategies/* 与工具共享）。 */
  readonly tombstones: BuiltinTombstonesStore
  constructor(ctx: Context, deps: { store: CustomStrategyStore; tombstones: BuiltinTombstonesStore }, serviceName: string = TRADING_STRATEGIES_KEY) {
    super(ctx, serviceName)
    this.store = deps.store
    this.tombstones = deps.tombstones
  }
}
