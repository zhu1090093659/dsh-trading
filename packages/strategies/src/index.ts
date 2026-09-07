/**
 * @dshtrading/strategies — 交易策略与纯函数回测内核：
 * 策略契约类型 + 纯函数回测引擎 + 6 个参考范式策略（短线/波段/长线）
 * + 5 个内置选股器（单时点截面筛选，ScreenerDefinition）。
 *
 * 纯库包，零运行时依赖，可直接在浏览器或 Node 端打包执行。
 */
export type {
  StrategyHorizon,
  SignalAction,
  StrategySignal,
  StrategyParamSpec,
  StrategyDefinition,
  TradeRecord,
  EquityPoint,
  BacktestMetrics,
  BacktestResult,
  BacktestOptions,
  Kline,
} from './types.ts'

export { run } from './engine.ts'

// 自定义策略管线（issue #31 / P2）：纯类型 + 内存存储 + 校验器（浏览器安全；
// file store 与 host 插件在 ./plugin 子路径，Node 侧专用，不进浏览器 bundle）。
export {
  createMemoryCustomStrategyStore,
  type CustomStrategyRecord,
  type CustomStrategyStore,
} from './custom.ts'
export {
  validateCustomStrategy,
  validateSignalSequence,
  compileStrategySource,
  type StrategyValidationResult,
} from './validate.ts'

// 策略管理（2026-09-07）：覆盖 + 墓碑模型的纯函数合成与内置源码导出；
// 墓碑内存存储浏览器安全（file 版在 ./plugin，Node 侧专用）。
export {
  BUILTIN_STRATEGY_IDS,
  BUILTIN_SCREENER_IDS,
  isBuiltinStrategyId,
  isBuiltinScreenerId,
  applyStrategyManagement,
  applyScreenerManagement,
  builtinStrategySource,
  builtinStrategyRecord,
  builtinScreenerSource,
  builtinScreenerRecord,
} from './management.ts'
export {
  createMemoryBuiltinTombstonesStore,
  type BuiltinTombstonesStore,
} from './builtin-tombstones.ts'
// 自定义选股器管线（选股器管理）：纯类型 + 内存存储 + 校验器（浏览器安全）。
export {
  createMemoryCustomScreenerStore,
  type CustomScreenerRecord,
  type CustomScreenerStore,
} from './custom-screener.ts'
export {
  validateCustomScreener,
  type ScreenerValidationResult,
} from './validate.ts'

export {
  screenerParadigms,
  getScreenerById,
  type ScreenerColumnSpec,
  type ScreenerDefinition,
  type ScreenerMatch,
} from './screeners/index.ts'

export {
  strategyParadigms,
  getStrategyById,
  donchianBreakoutStrategy,
  rsiReversionStrategy,
  emaCrossoverStrategy,
  bollingerReversionStrategy,
  smaBaselineStrategy,
  momentum12mStrategy,
} from './paradigms/index.ts'
