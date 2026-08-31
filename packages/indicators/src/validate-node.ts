/**
 * Node.js 宿主端专用校验执行器（带 node:vm 100ms 超时熔断，拦截死循环与卡死代码）。
 */
import * as vm from 'node:vm'
import type { IndicatorOutput, Kline } from './types.ts'
import { validateCustomIndicator, type ComputeRunner, type ValidationResult } from './validate.ts'

export const nodeVmComputeRunner: ComputeRunner = (
  computeSource: string,
  bars: readonly Kline[],
  params: Record<string, number>,
  timeoutMs = 100,
): IndicatorOutput[] => {
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
    return sandbox.result as IndicatorOutput[]
  } catch (error: any) {
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || String(error?.message).includes('timed out')) {
      throw new Error(`指标试算执行超时（超过 ${timeoutMs}ms），可能存在死循环（如 while/for 未退出）`)
    }
    throw error
  }
}

/** Node.js 宿主端校验器：自动启用 node:vm 超时熔断保护。 */
export function validateCustomIndicatorNode(raw: unknown): ValidationResult {
  return validateCustomIndicator(raw, { runner: nodeVmComputeRunner })
}
