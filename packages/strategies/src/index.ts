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

// 标的价格显示小数位（自适应 2→3 位）：client-ui 两包经此复用同一规则，
// 替代各处内联 toFixed(2) 对 3 位小数标的（港股 0.001 tick）的截断。
export { fmtPrice, priceDigits } from './price-format.ts'

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
// 浏览器 Worker 超时 runner 再导出（indicators 同源）：选股器扫描面用——
// 自定义 evaluate 在扫描循环里过 Worker 熔断，避免死循环卡死主线程。
// client-ui-strategies 只依赖本包，经此拿到 runner，不引 indicators。
export { workerComputeRunner } from '@dshtrading/indicators'

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
