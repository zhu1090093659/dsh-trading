/**
 * Node.js 宿主端专用校验执行器（带 node:vm 超时熔断，拦截死循环与卡死代码；
 * 默认 100ms，入口可经 trialTimeoutMs 注入放宽——issue #88）。
 */
import * as vm from 'node:vm'
import type { IndicatorOutput, Kline } from './types.ts'
import { validateCustomIndicator, type ComputeRunner, type ValidationResult } from './validate.ts'

/**
 * 用户源码 vm 沙箱执行的单一实现（指标/策略/选股器共用，2026-09-09 收敛自
 * strategies 的同体副本）：沙箱白名单全局、箭头/函数体双形态编译、超时熔断。
 * label 是超时文案的语境词（如「指标试算」/「策略试算」/「选股器试算」）——
 * 文案按调用语境归位，机制只此一份。
 */
export function runSourceInVmSandbox(
  computeSource: string,
  bars: readonly Kline[],
  params: Record<string, number>,
  timeoutMs: number,
  label: string,
): unknown {
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
    return sandbox.result
  } catch (error: any) {
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || String(error?.message).includes('timed out')) {
      throw new Error(`${label}执行超时（超过 ${timeoutMs}ms），可能存在死循环（如 while/for 未退出）`)
    }
    throw error
  }
}

export const nodeVmComputeRunner: ComputeRunner = (
  computeSource: string,
  bars: readonly Kline[],
  params: Record<string, number>,
  timeoutMs = 100,
): IndicatorOutput[] => runSourceInVmSandbox(computeSource, bars, params, timeoutMs, '指标试算') as IndicatorOutput[]

/**
 * Node.js 宿主端校验器：自动启用 node:vm 超时熔断保护。
 * trialTimeoutMs 缺省用 DEFAULT_TRIAL_TIMEOUT_MS（100ms）。
 */
export function validateCustomIndicatorNode(raw: unknown, options?: { trialTimeoutMs?: number | undefined }): ValidationResult {
  return validateCustomIndicator(raw, { runner: nodeVmComputeRunner, trialTimeoutMs: options?.trialTimeoutMs })
}
