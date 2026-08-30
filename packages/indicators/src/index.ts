/**
 * @dsh-trading/indicators — 技术指标核心库（纯库，非 dsh bundle）：
 * math 纯函数内核 + definition 契约类型 + 注册表工厂 + 预置指标数据。
 *
 * 消费方：client-ui-trading（宿主行情视图 + 本地注册表）与
 * client-ui-indicators（预置指标提供插件，经 cordis tradingIndicators
 * 服务暴露注册表）。跨包共享注册表只能走 cordis 服务单例。
 */
export type {
  IndicatorDefinition, IndicatorInstance, IndicatorOutput,
  IndicatorPane, IndicatorParamSpec, Kline,
} from './types.ts'
export { createIndicatorRegistry, type IndicatorRegistry } from './registry.ts'
export { presetDefinitions, MA_COLORS } from './presets.ts'
export {
  bollinger, ema, kdj, macd, rsi, sma, stdev,
  type Series,
} from './math.ts'
