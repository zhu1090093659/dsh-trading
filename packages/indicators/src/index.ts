/**
 * @dsh-trading/indicators — 技术指标核心库（纯库，非 dsh bundle）：
 * math 纯函数内核 + definition 契约类型 + 注册表工厂 + 预置指标数据 + 自定义指标纯函数校验器。
 *
 * 消费方：client-ui-trading（宿主行情视图 + 本地注册表）与
 * client-ui-indicators（预置指标提供插件，经 cordis tradingIndicators
 * 服务暴露注册表）。纯净无 Node.js 运行时依赖，支持浏览器打包。
 *
 * Node 端专用工具（如 createAuthorIndicatorTool, createFileCustomIndicatorStore）
 * 请经由子路径 `@dsh-trading/indicators/tool` 引用。
 */
export type {
  IndicatorDefinition, IndicatorInstance, IndicatorOutput,
  IndicatorPane, IndicatorParamSpec, Kline,
} from './types.ts'
export { createIndicatorRegistry, type IndicatorRegistry } from './registry.ts'
export { presetDefinitions, MA_COLORS, EMA_COLORS } from './presets.ts'
export {
  bollinger, ema, kdj, macd, rsi, sma, stdev,
  type Series,
} from './math.ts'
export {
  validateCustomIndicator,
  validateCustomIndicatorAsync,
  workerComputeRunner,
  compileComputeSource,
  createSampleBars,
  type ValidationResult,
  type AsyncComputeRunner,
} from './validate.ts'
export {
  createMemoryCustomIndicatorStore,
  type CustomIndicatorRecord,
  type CustomIndicatorStore,
} from './custom.ts'
