/**
 * @dshtrading/connector-hithink
 * K 线映射与本地聚合助手（A 股与期货共用）。
 *
 * 上游只有日线（A 股另加未开放的分钟模块）；3d/1w/1M 由日线本地聚合，
 * 期货分钟线由当日分时点聚合。东八区日界（中国无夏令时，固定 UTC+8）。
 *
 * @module @dshtrading/connector-hithink/kline
 */

import type { Kline } from '@dshtrading/api'

const DAY_MS = 86_400_000
const SHANGHAI_OFFSET_MS = 8 * 3_600_000

/** 东八区日序号（交易日零点 ms → 天数）。 */
function shanghaiDay(ms: number): number {
  return Math.floor((ms + SHANGHAI_OFFSET_MS) / DAY_MS)
}

/** 东八区日期键（YYYY-MM-DD），月/周聚合与 last_trade_date 过滤用。 */
export function shanghaiDateKey(ms: number): string {
  const d = new Date(ms + SHANGHAI_OFFSET_MS)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** ISO 周键（周一为一周起点，按东八区日界）。 */
function isoWeekKey(ms: number): string {
  const d = new Date(ms + SHANGHAI_OFFSET_MS)
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const dayOfWeek = (new Date(t).getUTCDay() + 6) % 7
  const monday = t - dayOfWeek * DAY_MS
  return String(monday)
}

/** 单位日K → 标准 Kline（closeTime = openTime + 1d - 1，与 eastmoney/tencent 约定一致）。 */
export function dailyBarToKline(
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Kline {
  return { openTime, open, high, low, close, volume, closeTime: openTime + DAY_MS - 1 }
}

/** 日K序列按日历桶聚合（'3d' 按东八区日序 3 天分桶；'1w' ISO 周；'1M' 自然月）。 */
export function aggregateDailyKlines(daily: Kline[], interval: '3d' | '1w' | '1M'): Kline[] {
  const buckets = new Map<string, { first: Kline; last: Kline; high: number; low: number; volume: number }>()
  for (const bar of daily) {
    const key = interval === '1w'
      ? isoWeekKey(bar.openTime)
      : interval === '1M'
        ? shanghaiDateKey(bar.openTime).slice(0, 7)
        : String(Math.floor(shanghaiDay(bar.openTime) / 3))
    const existing = buckets.get(key)
    if (!existing) {
      buckets.set(key, { first: bar, last: bar, high: bar.high, low: bar.low, volume: bar.volume })
      continue
    }
    existing.last = bar
    existing.high = Math.max(existing.high, bar.high)
    existing.low = Math.min(existing.low, bar.low)
    existing.volume += bar.volume
  }
  return [...buckets.values()].map((b) => ({
    openTime: b.first.openTime,
    open: b.first.open,
    high: b.high,
    low: b.low,
    close: b.last.close,
    volume: b.volume,
    closeTime: b.last.closeTime,
  }))
}

/** 分钟分桶聚合（分时点 → N 分钟 OHLC 条；volume 求和）。 */
export function aggregateMinutePoints(
  points: Array<{ timestamp: number; price: number; volume: number }>,
  stepMinutes: number,
): Kline[] {
  const stepMs = stepMinutes * 60_000
  const buckets = new Map<number, { openTime: number; open: number; high: number; low: number; close: number; volume: number }>()
  for (const p of points) {
    const openTime = Math.floor(p.timestamp / stepMs) * stepMs
    const existing = buckets.get(openTime)
    if (!existing) {
      buckets.set(openTime, { openTime, open: p.price, high: p.price, low: p.price, close: p.price, volume: p.volume })
      continue
    }
    existing.high = Math.max(existing.high, p.price)
    existing.low = Math.min(existing.low, p.price)
    existing.close = p.price
    existing.volume += p.volume
  }
  return [...buckets.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map((b) => ({ ...b, closeTime: b.openTime + stepMs - 1 }))
}
