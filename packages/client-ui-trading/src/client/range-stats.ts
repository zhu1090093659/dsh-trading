/**
 * 区间统计（2026-09-02）：「区间统计」按钮框选一段K线后的纯计算层，
 * 与渲染/图表 API 零耦合（QuoteStage 持有 klines，TvChart 只上报逻辑下标区间）。
 *
 * 口径（对齐同花顺区间统计）：
 * - 基准 = 区间首根收盘（首根自身的涨跌不计入区间涨跌幅）；
 * - 区间涨跌幅 = (末根收盘 - 基准) / 基准 × 100；
 * - 振幅 = (区间最高 - 区间最低) / 基准 × 100；
 * - 上涨/下跌根数按各根收盘与前一根收盘比较（区间首根以前一根收盘为基准，
 *   区间首根无前根时回退开盘价）。
 */
import type { Kline } from './types.ts'

export interface RangeStats {
  /** 区间K线数（含两端）。 */
  bars: number
  /** 区间首根/末根开盘时间（epoch ms）。 */
  startTime: number
  endTime: number
  /** 区间涨跌幅（%）。 */
  changePercent: number
  /** 区间涨跌（绝对价差，末根收盘 - 基准）。 */
  change: number
  rangeHigh: number
  /** 区间最高所在根的 openTime。 */
  highTime: number
  rangeLow: number
  /** 区间最低所在根的 openTime。 */
  lowTime: number
  /** 区间振幅（%，相对基准）。 */
  amplitudePercent: number
  /** 区间成交量合计（各根 volume 直和）。 */
  volume: number
  /** 收盘高于/低于前一根收盘的根数。 */
  upBars: number
  downBars: number
}

/**
 * 计算 [start, end] 闭区间的统计。start/end 允许倒序与越界（内部钳位交换）；
 * 区间为空（无数据 / 单点在数据集外）返回 null。
 */
export function computeRangeStats(klines: readonly Kline[], start: number, end: number): RangeStats | null {
  if (klines.length === 0) return null
  const lo = Math.max(0, Math.min(Math.floor(start), Math.floor(end)))
  const hi = Math.min(klines.length - 1, Math.max(Math.floor(start), Math.floor(end)))
  if (lo > hi) return null
  const first = klines[lo]
  const last = klines[hi]
  if (first === undefined || last === undefined) return null
  const base = first.close
  if (!Number.isFinite(base) || base <= 0) return null

  let rangeHigh = -Infinity
  let highTime = first.openTime
  let rangeLow = Infinity
  let lowTime = first.openTime
  let volume = 0
  let upBars = 0
  let downBars = 0
  let prevClose: number | undefined = lo > 0 ? klines[lo - 1]?.close : undefined
  for (let index = lo; index <= hi; index++) {
    const bar = klines[index]
    if (bar === undefined) continue
    if (bar.high > rangeHigh) {
      rangeHigh = bar.high
      highTime = bar.openTime
    }
    if (bar.low < rangeLow) {
      rangeLow = bar.low
      lowTime = bar.openTime
    }
    if (Number.isFinite(bar.volume)) volume += bar.volume
    const reference = prevClose ?? bar.open
    if (bar.close > reference) upBars++
    else if (bar.close < reference) downBars++
    prevClose = bar.close
  }

  return {
    bars: hi - lo + 1,
    startTime: first.openTime,
    endTime: last.openTime,
    changePercent: (last.close - base) / base * 100,
    change: last.close - base,
    rangeHigh,
    highTime,
    rangeLow,
    lowTime,
    amplitudePercent: (rangeHigh - rangeLow) / base * 100,
    volume,
    upBars,
    downBars,
  }
}
