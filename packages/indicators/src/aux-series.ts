/**
 * 指标外部序列注入缝（纯数据 + 纯函数，零 Node 依赖，浏览器安全）。
 *
 * 为什么需要：definition.compute 是纯同步函数（只吃 bars + params），没有取数
 * 能力；而港股通持股比例这类指标的数据来自宿主预取的**日频外部序列**（按交易日
 * 公布，与 K 线周期不对应）。本模块定义该注入缝的类型与对齐纯函数：指标用
 * definition.aux 声明需要的序列键，宿主按需 prefetch 后以同名键注入
 * definition.computeAux 的第三参。
 *
 * 两条注入通道的语义差别（2026-10-14 逐根通道）：
 * - `aux` = **日频外部序列**（按交易日公布，与 K 线周期不对应）。宿主取不到数据
 *   时不得调用 computeAux，消费方据此**整体隐藏**该指标实例——空 ≠ 0。
 * - `barAux` = **级别相关的增强通道**：宿主按当前 K 线级别逐根算好整条序列后
 *   注入 computeBarAux。它是增强而非数据源，缺失时指标**回落 compute**，绝不隐藏。
 */
import type { Kline } from './types.ts'

/** 指标可声明消费的外部日频序列数据点（按交易日升序、已去重）。 */
export interface AuxPoint {
  /** 交易日（UTC 当日 00:00 的 epoch ms）。 */
  readonly date: number
  readonly value: number
}

/**
 * 指标外部序列来源键（开放词汇；当前有 'hk-connect-holding' 与 'cn-active-buy'）。
 * 消费方（宿主）据此 prefetch，并把结果按同名键注入 compute 第三参。
 */
export type AuxSeriesKey = string

/** 注入进 compute 的外部序列集合：键 = 指标 definition.aux 声明的键。 */
export type AuxSeriesMap = Readonly<Record<string, readonly AuxPoint[]>>

/** 逐根序列来源键（开放词汇；当前有 'five-day-volume-tiers'）。 */
export type AuxBarSeriesKey = string

/** 逐根序列集合：键 = definition.barAux 声明的键。 */
export type AuxBarSeriesMap = Readonly<Record<string, readonly (number | undefined)[]>>

/**
 * 逐根序列的值不变量（宿主注入方的契约，消费方按此写纯函数）：
 * - 值数组长度**严格等于** bars.length（逐根对齐，不做前向填充、不做区间匹配）；
 * - `undefined` = 该根无值（指标据此留空，不是 0）；
 * - 数组元素只可能是有限数或 undefined，绝不出现 NaN/Infinity。
 */

/** 五日成交量档位通道键（冻结字面量）。 */
export const FIVE_DAY_VOLUME_TIER_AUX_KEY: AuxBarSeriesKey = 'five-day-volume-tiers'

/** 逐根档位编码词汇：下标即编码值。0 = 不可判（无前值/基准日/前值无量），1..4 = 量比四档。 */
export const FIVE_DAY_VOLUME_TIER_CODES = ['noPrior', 'lt1', 'lt2', 'lt3', 'gte3'] as const

/** 逐根档位编码（{@link FIVE_DAY_VOLUME_TIER_CODES} 的下标）。 */
export type FiveDayVolumeTierCode = 0 | 1 | 2 | 3 | 4

/**
 * 把日频外部序列对齐到 K 线序列：对每根 K 线取「date ≤ 该 K 线所属交易日」的
 * 最新一条外部值（前向填充，反映「该交易日收盘时已知的最新持股比例」）。
 * 早于首条外部数据的 K 线填 undefined。返回数组长度严格等于 bars.length。
 * dayOfKline: 由宿主传入的「K 线 → 交易日(UTC 00:00)」取值函数，避免本纯库
 * 依赖行情周期词汇。
 *
 * 前向填充的理由：港股通持股日频公布，K 线级别 ≥ 1d 时一个交易日一个点；但周 K/
 * 月 K 上一个 bar 覆盖多日，必须取区间内最新已知值，否则会用到未来数据。
 *
 * 每根 K 线独立二分取值：只依赖 points 升序（契约要求），不假设 bars 升序——
 * 宿主倒序传入或周期混排时每根 K 线拿到的仍是同一条值。
 */
export function alignAuxToBars(
  bars: readonly Kline[],
  points: readonly AuxPoint[],
  dayOfKline: (bar: Kline) => number,
): Array<number | undefined> {
  const aligned = new Array<number | undefined>(bars.length)
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]
    aligned[index] = bar === undefined ? undefined : valueAtOrBefore(points, dayOfKline(bar))
  }
  return aligned
}

/** 升序序列里 date ≤ day 的最后一条值；无命中（早于首条数据 / 空序列）返回 undefined。 */
function valueAtOrBefore(points: readonly AuxPoint[], day: number): number | undefined {
  let low = 0
  let high = points.length - 1
  let hit = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    const point = points[mid]
    if (point === undefined) break
    if (point.date <= day) {
      hit = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return hit < 0 ? undefined : points[hit]?.value
}
