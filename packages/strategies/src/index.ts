/**
 * @dsh-trading/strategies — 交易策略与纯函数回测内核：
 * 策略契约类型 + 纯函数回测引擎 + 6 个参考范式策略（短线/波段/长线）。
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
