/**
 * 选股器契约（对齐 docs/design/strategy-tab.md 的范式策略风格）：
 * 与 StrategyDefinition（时序信号 + 回测）不同，ScreenerDefinition 是
 * 「单时点截面判断」——对单个标的的日 K 窗口做纯函数评估，命中即入选，
 * 无信号序列、无回测语义。扫描调度（名册拉取/并发/进度）在视图层，
 * 本包只承载可独立单测的筛选逻辑。
 */
import type { Kline } from '@dshtrading/indicators'
import type { StrategyParamSpec } from '../types.ts'

export type { Kline }

/** 结果表动态列（每只标的命中后展示的指标值列）。 */
export interface ScreenerColumnSpec {
  readonly key: string
  readonly label: string
  /** percent = 按 % 渲染；缺省按普通数字渲染 */
  readonly format?: 'percent' | 'number'
}

/** 单标的命中结果（未命中由 evaluate 返回 null 表达，不进结果集）。 */
export interface ScreenerMatch {
  /** 动态指标值（key 对应 columns 声明） */
  readonly metrics: Readonly<Record<string, number>>
  /** 人话解释，UI 直接展示（zh 单语原文，回退用） */
  readonly reason: string
  /** reason 的词典键（client-ui-strategies 词典约定 scr.<id>.reason），
   *  视图按当前语言渲染 t(reasonKey, reasonParams)；缺省回退 reason 原文。 */
  readonly reasonKey?: string
  /** reasonKey 的 {placeholder} 插值参数。 */
  readonly reasonParams?: Readonly<Record<string, string | number>>
}

export interface ScreenerDefinition {
  /** 稳定词汇，加 'scr.' 前缀与范式策略 id 空间隔离（如 'scr.ma-bull-align'） */
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly params: readonly StrategyParamSpec[]
  readonly columns: readonly ScreenerColumnSpec[]
  /**
   * 纯函数：无 IO/随机/全局态；同一输入必须同一输出。
   * 数据不足（无法计算所需指标）返回 null——既不算命中也不算错误，
   * 新上市标的窗口不够时静默跳过。
   */
  evaluate(bars: readonly Kline[], params: Readonly<Record<string, number>>): ScreenerMatch | null
}
