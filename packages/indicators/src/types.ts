/**
 * 指标系统契约类型（纯数据）：definition 是指标系统的唯一扩展点——
 * pane 归属 + 显示字符串 + 参数 schema + 纯函数 compute。渲染层（宿主
 * 行情视图）只消费 compute 的输出，对指标实现零感知。
 *
 * 显示字段（title/label）是普通字符串而非 locale 键：宿主 locale 命名空间
 * 单占（重复 register 抛错），外部指标插件不可能往宿主拥有的命名空间贡献
 * 键；社区指标因此只需交付纯数据 definition，无需 i18n 通道。内置指标名
 * （MA/MACD 等）本身语言中立。
 */
import type { Series } from './math.ts'

/** K 线（与宿主行情数据结构对齐的最小面）。 */
export interface Kline {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  closeTime?: number
}

/** 指标归属：主图叠加（与蜡烛共享价格轴）或独立副图 pane。 */
export type IndicatorPane = 'main' | 'sub'

export interface IndicatorParamSpec {
  key: string
  /** 参数显示名（纯字符串，见模块头注）。 */
  label: string
  default: number
  min: number
  max: number
}

export interface IndicatorOutput {
  /** 实例内唯一（图例/序列 key）。 */
  key: string
  kind: 'line' | 'histogram' | 'area'
  color: string
  /** 与 K 线逐条对齐；undefined = warm-up，不画。 */
  values: Series
  /** histogram 专用：按符号红涨绿跌着色（MACD 柱）。 */
  histogramBySign?: boolean
  /** area 专用：顶部渐变色 */
  topColor?: string
  /** area 专用：底部渐变色 */
  bottomColor?: string
  /** area 专用：反转填充区（true 表示向线上方填充） */
  invertFilledArea?: boolean
  /** 线宽（1-4） */
  lineWidth?: number
}

export interface IndicatorDefinition {
  /** 注册唯一 id（如 'ma'）；实例按 id + 参数区分。 */
  id: string
  pane: IndicatorPane
  /** 指标显示名（纯字符串，见模块头注）。 */
  title: string
  params: readonly IndicatorParamSpec[]
  compute(bars: readonly Kline[], params: Readonly<Record<string, number>>): IndicatorOutput[]
}

/** 一个已激活的指标实例（每个 preset id 至多一个实例）。 */
export interface IndicatorInstance {
  id: string
  params: Record<string, number>
  /**
   * 按标的参数覆盖（issue #72）：key 为 `${market}:${symbol}`（如 "hk:00700.HK"），
   * 命中当前标的时该套参数整体替代全局 params。锚点类自定义指标（每标的一套
   * 锚点参数）依赖此机制；无覆盖的标的回退全局 params。
   */
  symbolParams?: Record<string, Record<string, number>>
  /**
   * 按标的隐藏表：作用域键为「market」（整市场，如 "us"）或「${market}:${symbol}」
   * （单标的，如 "hk:00700.HK"）。命中的标的不渲染该实例，其余标的跟随全局激活
   * （默认可见，存量名册零迁移）。隐藏 ≠ 取消激活：实例仍在名册，只是对该标的不可见。
   */
  hiddenScopes?: string[]
}
