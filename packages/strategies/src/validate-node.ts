/**
 * Node.js 宿主端专用策略校验执行器：vm 沙箱机制的单一实现在
 * @dshtrading/indicators 的 runSourceInVmSandbox（2026-09-09 收敛，此前为
 * 逐行同体副本）；本文件只保留策略/选股器语境的薄封装与超时文案归位。
 */
import type { Kline } from '@dshtrading/indicators'
import { runSourceInVmSandbox } from '@dshtrading/indicators/tool'
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
): StrategySignal[] => runSourceInVmSandbox(computeSource, bars, params, timeoutMs, '策略试算') as StrategySignal[]

/** Node.js 宿主端策略校验器：自动启用 node:vm 超时熔断保护。 */
export function validateCustomStrategyNode(raw: unknown): Promise<StrategyValidationResult> {
  return validateCustomStrategy(raw, { runner: nodeStrategyComputeRunner })
}

/**
 * Node 宿主端选股器 evaluate 试算 runner（同一 vm 沙箱形态；返回值形状由
 * validateCustomScreener 的 ScreenerMatch 校验把关，此处不约束类型）。
 * Promise 形态：抛错转拒绝，超时文案经 label 归位为「选股器试算」。
 */
export const nodeScreenerEvaluateRunner = (
  evaluateSource: string,
  bars: readonly Kline[],
  params: Record<string, number>,
  timeoutMs = 100,
): Promise<unknown> => {
  try {
    return Promise.resolve(runSourceInVmSandbox(evaluateSource, bars, params, timeoutMs, '选股器试算'))
  } catch (error) {
    return Promise.reject(error)
  }
}

/** Node.js 宿主端选股器校验器：vm 熔断 runner 注入。 */
export function validateCustomScreenerNode(raw: unknown): Promise<ScreenerValidationResult> {
  return validateCustomScreener(raw, { runner: nodeScreenerEvaluateRunner })
}
