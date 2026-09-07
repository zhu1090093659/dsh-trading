/**
 * Node.js 宿主端专用策略校验执行器（node:vm 100ms 超时熔断，仿 indicators
 * 的 validate-node.ts——issue #31 规格：Node 侧 vm 沙箱 + 超时熔断）。
 */
import * as vm from 'node:vm'
import type { Kline } from '@dshtrading/indicators'
import {
  validateCustomStrategy,
  validateCustomScreener,
  type ScreenerValidationResult,
  type StrategyValidationResult,
} from './validate.ts'
import type { StrategySignal } from './types.ts'

export const nodeStrategyComputeRunner = (
  computeSource: string,
  bars: readonly Kline[],
  params: Record<string, number>,
  timeoutMs = 100,
): StrategySignal[] => {
  const sandbox = {
    bars,
    params,
    result: null as unknown,
    Math,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Date,
  }
  const trimmed = computeSource.trim()
  let code: string
  if (/^(?:\([a-zA-Z0-9_,\s]*\)|[a-zA-Z0-9_]+)\s*=>/.test(trimmed) || /^function\b/.test(trimmed)) {
    code = `"use strict"; const fn = (${trimmed}); result = fn(bars, params);`
  } else {
    code = `"use strict"; const fn = (function(bars, params) { ${trimmed} }); result = fn(bars, params);`
  }
  const script = new vm.Script(code)
  const context = vm.createContext(sandbox)
  try {
    script.runInContext(context, { timeout: timeoutMs })
    return sandbox.result as StrategySignal[]
  } catch (error: any) {
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || String(error?.message).includes('timed out')) {
      throw new Error(`策略试算执行超时（超过 ${timeoutMs}ms），可能存在死循环（如 while/for 未退出）`)
    }
    throw error
  }
}

/** Node.js 宿主端策略校验器：自动启用 node:vm 超时熔断保护。 */
export function validateCustomStrategyNode(raw: unknown): Promise<StrategyValidationResult> {
  return validateCustomStrategy(raw, { runner: nodeStrategyComputeRunner })
}

/**
 * Node 宿主端选股器 evaluate 试算 runner（同一 vm 沙箱形态；返回值形状由
 * validateCustomScreener 的 ScreenerMatch 校验把关，此处不约束类型）。
 */
export const nodeScreenerEvaluateRunner = (
  evaluateSource: string,
  bars: readonly Kline[],
  params: Record<string, number>,
  timeoutMs = 100,
): Promise<unknown> => Promise.resolve(nodeStrategyComputeRunner(
  evaluateSource, bars, params, timeoutMs,
) as unknown)

/** Node.js 宿主端选股器校验器：vm 熔断 runner 注入。 */
export function validateCustomScreenerNode(raw: unknown): Promise<ScreenerValidationResult> {
  return validateCustomScreener(raw, { runner: nodeScreenerEvaluateRunner })
}
