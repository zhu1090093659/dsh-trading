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
import path from 'node:path'
import { dshHomeDir } from '@dshtrading/dsh-home'
import type { MarketDataService } from '@dshtrading/api'
import { getStrategyById, getScreenerById, run, screenerParadigms, strategyParadigms } from './index.ts'
import { createFileCustomStrategyStore } from './custom-fs.ts'
import type { CustomStrategyRecord, CustomStrategyStore } from './custom.ts'
import { createFileBuiltinTombstonesStore } from './builtin-tombstones-fs.ts'
import type { BuiltinTombstonesStore } from './builtin-tombstones.ts'
import { isBuiltinStrategyId, isBuiltinScreenerId } from './management.ts'
import { createFileCustomScreenerStore } from './custom-screener-fs.ts'
import type { CustomScreenerRecord, CustomScreenerStore } from './custom-screener.ts'

// 桥（client-ui-trading node 半）经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileCustomStrategyStore }
export { createFileBuiltinTombstonesStore }
export { createFileCustomScreenerStore }
export { isBuiltinStrategyId, isBuiltinScreenerId } from './management.ts'
// 桥（node 半）保存策略/选股器前的落盘前校验入口（vm 熔断）。
export { validateCustomStrategyNode, validateCustomScreenerNode } from './validate-node.ts'
import { compileStrategySource } from './validate.ts'
import { nodeScreenerEvaluateRunner, validateCustomStrategyNode, validateCustomScreenerNode } from './validate-node.ts'
import type { BacktestResult, Kline, StrategyDefinition, StrategyHorizon, StrategyParamSpec } from './types.ts'
import type { ScreenerColumnSpec, ScreenerDefinition } from './screeners/types.ts'

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

/** 默认存储路径：$DSH_HOME/strategies/custom.json（缺省 ~/.dsh）。 */
export function defaultStorePath(): string {
  return path.join(dshHomeDir(), 'strategies', 'custom.json')
}

/** 默认墓碑路径：$DSH_HOME/strategies/builtin-tombstones.json（策略管理）。 */
export function defaultTombstonesStorePath(): string {
  return path.join(dshHomeDir(), 'strategies', 'builtin-tombstones.json')
}

/** 默认自定义选股器路径：$DSH_HOME/strategies/custom-screeners.json（选股器管理）。 */
export function defaultScreenerStorePath(): string {
  return path.join(dshHomeDir(), 'strategies', 'custom-screeners.json')
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
        // 上一次覆盖记录将被本次 save 顶掉：先归档删除再落盘，旧修改可找回。
        const previousOverride = await store.get(result.record.id)
        if (previousOverride !== undefined) await store.remove(result.record.id, true)
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

export interface StrategyListToolOptions {
  store: CustomStrategyStore
  /** 可选：墓碑表（内置删除状态回显）。 */
  tombstones?: BuiltinTombstonesStore
}

/**
 * strategy_list 工厂（issue #86 / G3）：名册 + 覆盖 + 墓碑三态一次读全。
 * 此前 strategy_delete / strategy_backtest 都要 id 而 agent 拿不到 id，
 * 只能让用户口述或去读 ~/.dsh-trading/strategies/custom.json。
 */
export function createStrategyListTool(options: StrategyListToolOptions) {
  return defineTool({
    name: 'strategy_list',
    description:
      'List the user strategy roster: built-in paradigms (with their parameter keys/defaults), custom strategies authored via '
      + 'strategy_author, and tombstoned (deleted) built-in ids. Read-only. '
      + 'ALWAYS call this before strategy_backtest / strategy_delete / strategy_reset when you do not already have an id from this '
      + 'session, and before strategy_backtest with paramsJson so you know the declared parameter keys. '
      + 'A paradigm with overridden=true is a built-in currently replaced by a user record; deleted=true means the built-in is '
      + 'tombstoned and hidden from the roster until strategy_reset restores it.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const deleted = options.tombstones === undefined ? [] : await options.tombstones.list()
      const records = await options.store.list()
      const overridden = new Set(records.filter(record => isBuiltinStrategyId(record.id)).map(record => record.id))
      const paradigms = strategyParadigms.map(definition => ({
        id: definition.id,
        name: definition.name,
        horizon: definition.horizon,
        summary: definition.summary,
        params: definition.params.map(spec => ({ key: spec.key, label: spec.label, default: spec.default, min: spec.min, max: spec.max })),
        overridden: overridden.has(definition.id),
        deleted: deleted.includes(definition.id),
      }))
      const custom = records
        .filter(record => !isBuiltinStrategyId(record.id))
        .map(record => ({
          id: record.id,
          title: record.title,
          horizon: record.horizon,
          summary: record.summary,
          createdAt: record.createdAt,
        }))
      return JSON.stringify({ ok: true, paradigms, custom, deleted })
    },
  })
}

export interface ScreenerListToolOptions {
  store: CustomScreenerStore
  /** 可选：墓碑表（内置选股器删除状态回显）。 */
  tombstones?: BuiltinTombstonesStore
}

/** 选股器记录 → 名册条目（paramsJson/columnsJson 解析在读取边界，坏数据降级为空数组）。 */
function screenerRecordEntry(record: CustomScreenerRecord) {
  let params: StrategyParamSpec[] = []
  let columns: ScreenerColumnSpec[] = []
  try {
    const parsed = JSON.parse(record.paramsJson) as StrategyParamSpec[]
    if (Array.isArray(parsed)) params = parsed
  } catch {
    params = []
  }
  try {
    const parsed = JSON.parse(record.columnsJson) as ScreenerColumnSpec[]
    if (Array.isArray(parsed)) columns = parsed
  } catch {
    columns = []
  }
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    params: params.map(spec => ({ key: spec.key, label: spec.label, default: spec.default, min: spec.min, max: spec.max })),
    columns: columns.map(column => ({ key: column.key, label: column.label, ...(column.format !== undefined ? { format: column.format } : {}) })),
    createdAt: record.createdAt,
  }
}

/** screener_list 工厂（issue #86 / G3）：选股器名册三态一次读全。 */
export function createScreenerListTool(options: ScreenerListToolOptions) {
  return defineTool({
    name: 'screener_list',
    description:
      'List the screener roster: built-in screeners (with their parameter keys and result column keys), custom screeners authored via '
      + 'screener_author, and tombstoned (deleted) built-in screener ids. Read-only. '
      + 'ALWAYS call this before screener_run / screener_delete / screener_reset when you do not already have an id from this session. '
      + 'A screener with overridden=true is a built-in currently replaced by a user record; deleted=true means the built-in is tombstoned '
      + 'and hidden from the roster until screener_reset restores it.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const deleted = options.tombstones === undefined ? [] : await options.tombstones.list()
      const records = await options.store.list()
      const overridden = new Set(records.filter(record => isBuiltinScreenerId(record.id)).map(record => record.id))
      const paradigms = screenerParadigms.map(definition => ({
        id: definition.id,
        name: definition.name,
        summary: definition.summary,
        params: definition.params.map(spec => ({ key: spec.key, label: spec.label, default: spec.default, min: spec.min, max: spec.max })),
        columns: definition.columns.map(column => ({
          key: column.key,
          label: column.label,
          ...(column.format !== undefined ? { format: column.format } : {}),
        })),
        overridden: overridden.has(definition.id),
        deleted: deleted.includes(definition.id),
      }))
      const custom = records
        .filter(record => !isBuiltinScreenerId(record.id))
        .map(record => screenerRecordEntry(record))
      return JSON.stringify({ ok: true, paradigms, custom, deleted })
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
    try {
      return {
        id: record.id,
        horizon: record.horizon,
        name: record.title,
        summary: record.summary,
        params,
        compute: compileStrategySource(record.computeSource),
      }
    } catch {
      // 损坏的记录（如手改 custom.json）：与 GUI 名册同语义——回落出厂内置，
      // 不让一次裸编译错误替换掉友好的 unknown-strategy 文案。
      if (isBuiltinStrategyId(record.id)) return getStrategyById(record.id)
      return undefined
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
      + 'Signals confirm at bar close and fill at the next bar open with fee/slippage modeling; this is simulation only — it never places orders. '
      + 'Pass paramsJson to override declared parameters (values clamped to min/max) and read the echoed params.effective; '
      + 'call strategy_list first when you need an id or its parameter keys.',
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
      paramsJson: {
        type: 'string',
        description:
          'Optional JSON object string overriding strategy parameters for this run, e.g. {"fast":10,"slow":30}. '
          + 'Keys must be declared by the strategy (see strategy_list); values are clamped to each param min/max and the effective '
          + 'values are echoed back in the result. Use this to reproduce a parameter set the user tuned in the GUI.',
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

      // 参数覆盖（issue #86 / G3）：UI 侧参数是 localStorage-only，agent 复现用户调过的
      // 参数组合此前做不到；这里按声明校验 + clamp，并回显实际生效值。
      const requested: Record<string, number> = {}
      const paramsOverride: Record<string, number> = {}
      const paramsJson = typeof args.paramsJson === 'string' && args.paramsJson.trim() ? args.paramsJson.trim() : undefined
      if (paramsJson !== undefined) {
        let parsed: unknown
        try {
          parsed = JSON.parse(paramsJson)
        } catch {
          throw new Error('strategy_backtest: paramsJson must be a JSON object string like {"fast":10,"slow":30}')
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('strategy_backtest: paramsJson must be a JSON object string like {"fast":10,"slow":30}')
        }
        const specs = new Map(definition.params.map(spec => [spec.key, spec]))
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          const spec = specs.get(key)
          if (spec === undefined) {
            throw new Error(
              `strategy_backtest: unknown param ${JSON.stringify(key)} for strategy "${definition.id}" — valid keys: `
              + (definition.params.length > 0 ? definition.params.map(item => item.key).join(', ') : '(this strategy declares no params)'),
            )
          }
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`strategy_backtest: param ${JSON.stringify(key)} must be a finite number (got ${JSON.stringify(value)})`)
          }
          requested[key] = value
          paramsOverride[key] = Math.min(spec.max, Math.max(spec.min, value))
        }
      }
      const effectiveParams: Record<string, number> = {}
      for (const spec of definition.params) effectiveParams[spec.key] = paramsOverride[spec.key] ?? spec.default

      const result: BacktestResult = run(bars, definition, paramsOverride)
      return JSON.stringify({
        ok: true,
        strategy: { id: definition.id, name: definition.name, horizon: definition.horizon },
        market,
        symbol,
        interval,
        barsTested: bars.length,
        params: { requested, effective: effectiveParams },
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
        // 内置删除丢弃覆盖记录：归档后可找回（出厂代码由墓碑/恢复语义保证）。
        const discardedOverride = await store.remove(id, true)
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
      // 恢复出厂丢弃覆盖记录：归档后可找回。
      const removedOverride = await store.remove(id, true)
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

export interface ScreenerAuthorToolOptions {
  store: CustomScreenerStore
  /** 可选：墓碑表（覆盖内置选股器时顺带恢复删除标记）。 */
  tombstones?: BuiltinTombstonesStore
  /** 可选：选股器成功落盘后的回调（emit('strategies') 接线点）。 */
  onWritten?: (record: CustomScreenerRecord) => void
}

/**
 * screener_author 工厂（选股器管理）：提交 → 结构/语法/多场景试算校验（vm 熔断）
 * → 落盘。evaluate(bars, params) 返回 ScreenerMatch | null（单时点截面判断，
 * 无信号序列语义）。id 为内置选股器（'scr.*'）→ 覆盖该内置（strategy_reset/
 * screener_reset 可恢复出厂）。
 */
export function createScreenerAuthorTool(options: ScreenerAuthorToolOptions) {
  const { store, tombstones, onWritten } = options
  return defineTool({
    name: 'screener_author',
    description:
      'Author, validate, and persist a custom stock screener from JavaScript evaluate source. '
      + 'evaluate(bars, params) is a single-point cross-section predicate: return a ScreenerMatch '
      + '({ metrics: Record<string, number> with keys declared in columns, reason }) or null when the symbol '
      + 'does not match / lacks data. The validator runs sandbox trial calculations across multiple kline scenarios. '
      + 'If valid, the screener is persisted and immediately available in the GUI screener roster. '
      + 'Submitting an id equal to a built-in screener id (scr.ma-bull-align / scr.volume-breakout / scr.rsi-oversold '
      + '/ scr.near-high / scr.above-ma) OVERRIDES that built-in screener (factory default stays recoverable via screener_reset).',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Unique screener id with "scr." prefix (e.g. "scr.custom-momentum"); a built-in screener id means overriding that built-in',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Display name (1-32 chars), e.g. "量价双确认"',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'One-sentence idea summary (≤120 chars), shown in the screener roster',
      },
      paramsJson: {
        type: 'string',
        description:
          'JSON string of StrategyParamSpec[] (optional, default []). Each spec: { key, label, default, min, max } with numeric default/min/max and min < max.',
      },
      columnsJson: {
        type: 'string',
        required: true,
        description:
          'JSON string of ScreenerColumnSpec[] (1-8 columns). Each spec: { key, label, format?: "percent" | "number" }. '
          + 'Match metrics keys must be declared here. JSON example: [{"key":"volRatio","label":"量比(倍)"}]',
      },
      evaluateSource: {
        type: 'string',
        required: true,
        description:
          'JavaScript pure function source, signature (bars, params) => ScreenerMatch | null. '
          + 'bars has { openTime, open, high, low, close, volume }. Return null to skip the symbol (no match or insufficient data). '
          + 'metrics values must be finite numbers with keys declared in columnsJson; reason is a non-empty human-readable string.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const candidate: CustomScreenerRecord = {
        id: typeof args.id === 'string' ? args.id : '',
        title: typeof args.title === 'string' ? args.title : '',
        horizon: 'swing',
        summary: typeof args.summary === 'string' ? args.summary : '',
        paramsJson: typeof args.paramsJson === 'string' && args.paramsJson.trim() ? args.paramsJson.trim() : '[]',
        columnsJson: typeof args.columnsJson === 'string' ? args.columnsJson : '',
        evaluateSource: typeof args.evaluateSource === 'string' ? args.evaluateSource : '',
        createdAt: Date.now(),
      }

      const result = await validateCustomScreenerNode(candidate)
      if (!result.ok) {
        return (
          `[screener_author] Validation failed: ${result.reason}\n`
          + 'Review the requirements: evaluate(bars, params) returns ScreenerMatch | null; metrics keys must be declared '
          + 'in columnsJson with finite number values; reason must be a non-empty string; return null to skip a symbol.'
        )
      }

      const overridesBuiltin = isBuiltinScreenerId(result.record.id)
      if (overridesBuiltin) {
        // 覆盖内置 = 恢复该 id 的删除标记（author 即「要回它」）。
        // 上一次覆盖记录将被本次 save 顶掉：先归档删除再落盘，旧修改可找回。
        const previousOverride = await store.get(result.record.id)
        if (previousOverride !== undefined) await store.remove(result.record.id, true)
        await tombstones?.remove(result.record.id)
      }
      await store.save(result.record)
      onWritten?.(result.record)

      const columnKeys = result.definition.columns.map((c) => c.key).join(', ')
      return (
        `[screener_author] Successfully authored screener "${result.record.title}" (id: ${result.record.id}`
        + (columnKeys ? `, columns: ${columnKeys}` : '') + '). '
        + 'The screener passed sandbox trials across 5 kline scenarios and is now persisted to the GUI screener roster. '
        + (overridesBuiltin
          ? 'This id is a built-in screener — the factory default remains recoverable via screener_reset.'
          : 'Run scans from the GUI screener pane.')
      )
    },
  })
}

export interface ScreenerDeleteToolOptions {
  store: CustomScreenerStore
  tombstones?: BuiltinTombstonesStore
  /** 可选：删除成功后的回调（emit('strategies') 接线点）。 */
  onDeleted?: (id: string, scope: 'custom' | 'builtin', removed: boolean) => void
}

/**
 * screener_delete 工厂（选股器管理）：自定义选股器 = 移除记录；内置选股器 =
 * 落墓碑（出厂代码不动，screener_reset 可恢复）。与 strategy_delete 共用墓碑表。
 */
export function createScreenerDeleteTool(options: ScreenerDeleteToolOptions) {
  const { store, tombstones, onDeleted } = options
  return defineTool({
    name: 'screener_delete',
    description:
      'Delete a screener by id. Custom screeners (authored via screener_author) are removed from the library; '
      + 'built-in screener ids (scr.ma-bull-align / scr.volume-breakout / scr.rsi-oversold / scr.near-high / scr.above-ma) '
      + 'are tombstoned instead — the built-in disappears from the GUI screener roster but stays recoverable via screener_reset. '
      + 'Deleting a built-in also discards any user override of it.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Screener id to delete (a custom id or a built-in screener id)',
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
        throw new Error('screener_delete: id is required')
      }
      if (isBuiltinScreenerId(id)) {
        await tombstones?.add(id)
        // 内置删除丢弃覆盖记录：归档后可找回。
        const discardedOverride = await store.remove(id, true)
        onDeleted?.(id, 'builtin', true)
        return JSON.stringify({
          ok: true,
          scope: 'builtin',
          deleted: true,
          discardedOverride,
          note: `Built-in screener "${id}" is now tombstoned — hidden from the GUI screener roster. Call screener_reset to restore the factory default.`,
        })
      }
      const removed = await store.remove(id)
      onDeleted?.(id, 'custom', removed)
      return JSON.stringify({
        ok: true,
        scope: 'custom',
        deleted: removed,
        note: removed
          ? `Deleted custom screener "${id}".`
          : `"${id}" was not found in the custom screener library (built-in ids are handled by tombstone — double-check the id).`,
      })
    },
  })
}

export interface ScreenerResetToolOptions {
  store: CustomScreenerStore
  tombstones?: BuiltinTombstonesStore
  /** 可选：恢复成功后的回调（emit('strategies') 接线点）。 */
  onReset?: (id: string, changed: boolean) => void
}

/**
 * screener_reset 工厂（选股器管理）：恢复内置选股器出厂默认——清覆盖记录与墓碑。
 * 仅对内置选股器 id 有意义；自定义选股器无出厂版本，明确报错引导 screener_delete。
 */
export function createScreenerResetTool(options: ScreenerResetToolOptions) {
  const { store, tombstones, onReset } = options
  return defineTool({
    name: 'screener_reset',
    description:
      'Restore a built-in screener (scr.ma-bull-align / scr.volume-breakout / scr.rsi-oversold / scr.near-high / scr.above-ma) '
      + 'to its factory default: any user override is discarded and a deletion tombstone is lifted. Custom screener ids '
      + 'have no factory default — use screener_delete for those.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Built-in screener id to restore',
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
        throw new Error('screener_reset: id is required')
      }
      if (!isBuiltinScreenerId(id)) {
        throw new Error(
          `screener_reset: "${id}" is not a built-in screener id — custom screeners have no factory default; use screener_delete to remove them`,
        )
      }
      // 恢复出厂丢弃覆盖记录：归档后可找回。
      const removedOverride = await store.remove(id, true)
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
          ? `Built-in screener "${id}" restored to factory default (override/tombstone cleared).`
          : `"${id}" was already at factory default — nothing to restore.`,
      })
    },
  })
}

/** Host plugin body：provide store 服务 + 注册策略工具族（host 平面，全会话可见）。 */
export function apply(ctx: Context): void {
  const store = createFileCustomStrategyStore(defaultStorePath())
  const tombstones = createFileBuiltinTombstonesStore(defaultTombstonesStorePath())
  const screenerStore = createFileCustomScreenerStore(defaultScreenerStorePath())
  // Service 单实例（issue #33 收口模式，同 indicators 的 tradingCustomIndicators）：
  // 桥（client-ui-trading node 半）经 ctx.get 解包 .store/.tombstones 复用同一
  // 实例——此前桥自建第二个 file store，工具写入与桥缓存互不感知（跨实例 stale 窗口）。
  new StrategiesStoreService(ctx, { store, tombstones, screenerStore })

  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (!tools || typeof tools.register !== 'function') return

    const events = () => eventsOf(ctx)?.emit('strategies')
    const register = (tool: ReturnType<typeof defineTool>) => {
      if (tools.get(tool.name) === undefined) tools.register(tool)
    }

    register(createStrategyAuthorTool({ store, tombstones, onWritten: () => events() }))
    register(createStrategyListTool({ store, tombstones }))
    register(createStrategyBacktestTool({ store, tombstones, marketData: createMarketDataResolver(ctx) }))
    register(createStrategyDeleteTool({ store, tombstones, onDeleted: () => events() }))
    register(createStrategyResetTool({ store, tombstones, onReset: () => events() }))
    // 选股器管理工具族（选股器管理，2026-09-07）。
    register(createScreenerAuthorTool({ store: screenerStore, tombstones, onWritten: () => events() }))
    register(createScreenerDeleteTool({ store: screenerStore, tombstones, onDeleted: () => events() }))
    register(createScreenerResetTool({ store: screenerStore, tombstones, onReset: () => events() }))
    register(createScreenerListTool({ store: screenerStore, tombstones }))
    // 扫描调度（issue #86 / G4）：registry-first 解析 provider 与行情服务，
    // 老部署（无 registry）回落市场键直读——与 createMarketDataResolver 同纪律。
    const marketDataFallback = createMarketDataResolver(ctx)
    register(createScreenerRunTool({
      store: screenerStore,
      tombstones,
      active: (market) => {
        const registry = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown })
          .get?.('tradingMarketDataRegistry', false) as { active(m: string): { provider: string; service: MarketDataService } | undefined } | undefined
        return registry?.active(market)
      },
      fallback: marketDataFallback,
    }))
  })
}

/* ------------------------------------------------------------------ */
/* screener_run（issue #86 / G4）：host 侧扫描调度                       */
/* ------------------------------------------------------------------ */

/** 扫描护栏（对齐 client-ui-strategies 视图层口径，显式回显给模型）。 */
const SCREENER_SCAN_CONCURRENCY = 5
const SCREENER_KLINE_WINDOW = 500
const SCREENER_DEFAULT_POOL = 100
const SCREENER_MAX_POOL = 500
const SCREENER_RESULT_LIMIT = 50
const SCREENER_EVAL_TIMEOUT_MS = 1000
const SCREENER_FETCH_TIMEOUT_MS = 8000

/** 解析后的选股器：内置（可信代码）或自定义（源码经 vm 熔断 runner 执行）。 */
export type ResolvedScreener =
  | { kind: 'builtin'; definition: ScreenerDefinition }
  | {
    kind: 'custom'
    id: string
    name: string
    summary: string
    params: StrategyParamSpec[]
    columns: ScreenerColumnSpec[]
    evaluateSource: string
  }

function parseScreenerSpecs(record: CustomScreenerRecord): { params: StrategyParamSpec[]; columns: ScreenerColumnSpec[] } {
  let params: StrategyParamSpec[] = []
  let columns: ScreenerColumnSpec[] = []
  try {
    const parsed = JSON.parse(record.paramsJson) as StrategyParamSpec[]
    if (Array.isArray(parsed)) params = parsed
  } catch {
    params = []
  }
  try {
    const parsed = JSON.parse(record.columnsJson) as ScreenerColumnSpec[]
    if (Array.isArray(parsed)) columns = parsed
  } catch {
    columns = []
  }
  return { params, columns }
}

/**
 * 选股器解析（覆盖 + 墓碑合成，与 resolveStrategyDefinition 同模型）：
 * 墓碑命中 → undefined；自定义记录优先（覆盖内置同 id）；损坏记录回落内置
 * 出厂定义，非内置损坏记录视为不存在（与名册语义一致）。
 */
export async function resolveScreener(
  store: CustomScreenerStore,
  screenerId: string,
  options?: { tombstones?: BuiltinTombstonesStore | undefined },
): Promise<ResolvedScreener | undefined> {
  if (await isTombstoned(options?.tombstones, screenerId)) return undefined
  const record = await store.get(screenerId)
  if (record !== undefined) {
    try {
      // 编译探针：损坏/不可编译的源码不进入扫描循环（否则每个标的都失败）。
      compileStrategySource(record.evaluateSource)
      const { params, columns } = parseScreenerSpecs(record)
      return {
        kind: 'custom',
        id: record.id,
        name: record.title,
        summary: record.summary,
        params,
        columns,
        evaluateSource: record.evaluateSource,
      }
    } catch {
      if (isBuiltinScreenerId(record.id)) {
        const builtin = getScreenerById(record.id)
        return builtin === undefined ? undefined : { kind: 'builtin', definition: builtin }
      }
      return undefined
    }
  }
  const builtin = getScreenerById(screenerId)
  return builtin === undefined ? undefined : { kind: 'builtin', definition: builtin }
}

/** 单次 await 的超时熔断（数据源挂死不能让一次工具调用无限期占用）。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 解析 paramsJson（与 strategy_backtest 同口径：声明键校验 + clamp）。 */
function parseParamsOverride(
  paramsJson: string | undefined,
  specs: readonly StrategyParamSpec[],
  tool: string,
  ownerId: string,
): { requested: Record<string, number>; effective: Record<string, number> } {
  const requested: Record<string, number> = {}
  const override: Record<string, number> = {}
  if (paramsJson !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(paramsJson)
    } catch {
      throw new Error(`${tool}: paramsJson must be a JSON object string like {"window":120}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${tool}: paramsJson must be a JSON object string like {"window":120}`)
    }
    const byKey = new Map(specs.map(spec => [spec.key, spec]))
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const spec = byKey.get(key)
      if (spec === undefined) {
        throw new Error(
          `${tool}: unknown param ${JSON.stringify(key)} for "${ownerId}" — valid keys: `
          + (specs.length > 0 ? specs.map(item => item.key).join(', ') : '(no params declared)'),
        )
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${tool}: param ${JSON.stringify(key)} must be a finite number (got ${JSON.stringify(value)})`)
      }
      requested[key] = value
      override[key] = Math.min(spec.max, Math.max(spec.min, value))
    }
  }
  const effective: Record<string, number> = {}
  for (const spec of specs) effective[spec.key] = override[spec.key] ?? spec.default
  return { requested, effective }
}

export interface ScreenerRunToolDeps {
  store: CustomScreenerStore
  tombstones?: BuiltinTombstonesStore
  /** registry-first 解析（provider 标签 + 行情服务）。 */
  active: (market: string) => { provider: string; service: MarketDataService } | undefined
  /** 老部署回退：市场键直读行情服务（无 registry 时）。 */
  fallback?: (market: string) => MarketDataService | undefined
}

/**
 * screener_run 工厂（issue #86 / G4）：把选股器从「只对 UI 可用」提升为 agent 可跑。
 * 扫描调度 = 名册 → 截断扫描池 → 受限并发拉 500 根日 K → 纯函数 evaluate；
 * 数据不足（evaluate 返回 null）静默跳过，单标的失败只计数不中断。
 * 只读行情 + 本地计算，无交易语义（铁律 #3 不涉及）。
 */
export function createScreenerRunTool(deps: ScreenerRunToolDeps) {
  return defineTool({
    name: 'screener_run',
    description:
      'Run one screener (built-in or custom, by id from screener_list) over a market and return the matched instruments with their '
      + 'metric columns and a one-line reason. Read-only cross-sectional scan: it fetches daily candles from the routed market data '
      + 'provider, evaluates a pure function per instrument, and never places orders or emits trading signals. '
      + 'Instruments whose window is too short are skipped silently (contract semantics); per-instrument fetch/evaluate failures are '
      + 'counted, never fatal. Cost guards are explicit in the result: scanPool (pool cap), scanned, failed, insufficient, '
      + 'resultLimit and truncated. ALWAYS call screener_list first to get the id and its parameter/column keys.',
    parameters: {
      screenerId: {
        type: 'string',
        required: true,
        description: 'Screener id from screener_list (built-in like scr.ma-bull-align, or a custom id)',
      },
      market: {
        type: 'string',
        required: true,
        description: 'Market vocabulary: crypto | us | cn | hk',
      },
      limit: {
        type: 'number',
        description: `Scan pool cap: how many instruments of the market roster to scan (default ${SCREENER_DEFAULT_POOL}, max ${SCREENER_MAX_POOL})`,
      },
      paramsJson: {
        type: 'string',
        description: 'Optional JSON object string overriding screener parameters, e.g. {"window":120}; clamped to each param min/max and echoed in params.effective',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const screenerId = typeof args.screenerId === 'string' ? args.screenerId.trim() : ''
      const market = typeof args.market === 'string' ? args.market.trim() : ''
      if (!screenerId || !market) throw new Error('screener_run: screenerId and market are required')
      const poolCap = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(SCREENER_MAX_POOL, Math.max(1, Math.floor(args.limit)))
        : SCREENER_DEFAULT_POOL

      const resolved = await resolveScreener(deps.store, screenerId, { tombstones: deps.tombstones })
      if (resolved === undefined) {
        if (await isTombstoned(deps.tombstones, screenerId)) {
          throw new Error(
            `screener_run: screener "${screenerId}" has been deleted by the user — call screener_reset with this id to restore the `
            + 'built-in, or screener_author to re-create it.',
          )
        }
        throw new Error(
          `screener_run: unknown screenerId "${screenerId}" — call screener_list for the current ids, or author one with screener_author.`,
        )
      }

      const active = deps.active(market)
      const service = active?.service ?? deps.fallback?.(market)
      if (service === undefined) {
        throw new Error(`screener_run: no market data service for market "${market}" — install/activate a market connector first`)
      }
      const provider = active?.provider ?? 'unknown'
      if (typeof service.listInstruments !== 'function') {
        return JSON.stringify({
          ok: false,
          code: 'TRADING_NO_UNIVERSE',
          market,
          provider,
          note: `market "${market}" provider "${provider}" exposes no instrument roster (listInstruments) — screener_run cannot build a scan pool. `
            + 'Scan a specific symbol instead with strategy_backtest, or pick a provider that lists instruments.',
        })
      }
      const universe = await service.listInstruments()
      if (!Array.isArray(universe) || universe.length === 0) {
        return JSON.stringify({
          ok: false,
          code: 'TRADING_NO_UNIVERSE',
          market,
          provider,
          note: `market "${market}" provider "${provider}" returned an empty instrument roster — nothing to scan.`,
        })
      }

      const specs = resolved.kind === 'builtin' ? resolved.definition.params : resolved.params
      const paramsJson = typeof args.paramsJson === 'string' && args.paramsJson.trim() ? args.paramsJson.trim() : undefined
      const { requested, effective } = parseParamsOverride(paramsJson, specs, 'screener_run', resolved.kind === 'builtin' ? resolved.definition.id : resolved.id)

      const pool = universe.slice(0, poolCap)
      const matched: Array<Record<string, unknown>> = []
      let scanned = 0
      let failed = 0
      let insufficient = 0
      let cursor = 0

      const evaluate = async (bars: Kline[]): Promise<unknown> => {
        if (resolved.kind === 'builtin') return resolved.definition.evaluate(bars, effective)
        return withTimeout(
          nodeScreenerEvaluateRunner(resolved.evaluateSource, bars, effective, SCREENER_EVAL_TIMEOUT_MS),
          SCREENER_EVAL_TIMEOUT_MS + 500,
          `screener_run evaluate(${resolved.id})`,
        )
      }

      const worker = async (): Promise<void> => {
        while (cursor < pool.length) {
          const instrument = pool[cursor]
          cursor += 1
          if (instrument === undefined) return
          try {
            const bars = await withTimeout(
              service.getKlines(instrument.symbol, '1d', SCREENER_KLINE_WINDOW),
              SCREENER_FETCH_TIMEOUT_MS,
              `screener_run getKlines(${instrument.symbol})`,
            )
            if (!Array.isArray(bars) || bars.length === 0) {
              failed += 1
              continue
            }
            const match = await evaluate(bars)
            if (match === null || match === undefined) {
              insufficient += 1
              continue
            }
            if (typeof match !== 'object' || typeof (match as { reason?: unknown }).reason !== 'string') {
              failed += 1
              continue
            }
            const hit = match as { metrics?: Record<string, number>; reason: string; reasonKey?: string; reasonParams?: Record<string, string | number> }
            matched.push({
              symbol: instrument.symbol,
              ...(instrument.name !== undefined ? { name: instrument.name } : {}),
              price: bars[bars.length - 1]?.close ?? null,
              metrics: hit.metrics ?? {},
              reason: hit.reason,
              ...(hit.reasonKey !== undefined ? { reasonKey: hit.reasonKey } : {}),
              ...(hit.reasonParams !== undefined ? { reasonParams: hit.reasonParams } : {}),
            })
          } catch {
            failed += 1
          } finally {
            scanned += 1
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(SCREENER_SCAN_CONCURRENCY, pool.length) }, () => worker()))

      const results = matched.slice(0, SCREENER_RESULT_LIMIT)
      return JSON.stringify({
        ok: true,
        screenerId: resolved.kind === 'builtin' ? resolved.definition.id : resolved.id,
        screenerName: resolved.kind === 'builtin' ? resolved.definition.name : resolved.name,
        market,
        provider,
        interval: '1d',
        klineWindow: SCREENER_KLINE_WINDOW,
        universeSize: universe.length,
        scanPool: pool.length,
        scanned,
        failed,
        insufficient,
        matched: matched.length,
        returned: results.length,
        resultLimit: SCREENER_RESULT_LIMIT,
        truncated: matched.length > SCREENER_RESULT_LIMIT,
        params: { requested, effective },
        results,
        note: 'Read-only cross-sectional scan (no trading signals). failed = fetch/evaluate errors; insufficient = window too short for the '
          + 'screener (contract: skipped silently). Raise limit to widen the pool (max ' + SCREENER_MAX_POOL + ').',
      })
    },
  })
}

/** 策略 store 服务（桥与工具的单实例共享点，issue #33 收口模式）。 */
export class StrategiesStoreService extends Service {
  readonly store: CustomStrategyStore
  /** 内置墓碑表（策略/选股器管理共用；桥 DELETE/POST /strategies/* 与工具共享）。 */
  readonly tombstones: BuiltinTombstonesStore
  /** 自定义选股器 store（选股器管理）。 */
  readonly screenerStore: CustomScreenerStore
  constructor(
    ctx: Context,
    deps: { store: CustomStrategyStore; tombstones: BuiltinTombstonesStore; screenerStore: CustomScreenerStore },
    serviceName: string = TRADING_STRATEGIES_KEY,
  ) {
    super(ctx, serviceName)
    this.store = deps.store
    this.tombstones = deps.tombstones
    this.screenerStore = deps.screenerStore
  }
}
