/**
 * 区间统计纯计算层单测：口径冻结（基准=首根收盘、振幅相对基准、涨跌根数
 * 以前收为参照）、倒序/越界钳位、空数据 null。
 */
import { describe, expect, it } from 'vitest'
import { computeRangeStats } from '../src/client/range-stats.ts'
import type { Kline } from '../src/client/types.ts'

function bar(openTime: number, open: number, high: number, low: number, close: number, volume = 0): Kline {
  return { openTime, open, high, low, close, volume, closeTime: openTime + 60_000 - 1 }
}

const KLINES: Kline[] = [
  bar(1000, 10, 11, 9, 10.5, 100),
  bar(2000, 10.5, 12, 10, 11, 200),
  bar(3000, 11, 13, 10.5, 12.5, 300),
  bar(4000, 12.5, 12.8, 11.2, 11.5, 400),
  bar(5000, 11.5, 12, 10, 10.4, 500),
]

describe('computeRangeStats', () => {
  it('上涨区间：涨跌幅/涨跌/高低/振幅/成交量按口径计算', () => {
    const stats = computeRangeStats(KLINES, 1, 3)
    expect(stats).not.toBeNull()
    const s = stats!
    expect(s.bars).toBe(3)
    expect(s.startTime).toBe(2000)
    expect(s.endTime).toBe(4000)
    // 基准 = 首根（idx1）收盘 11；末根收盘 11.5。
    expect(s.change).toBeCloseTo(0.5, 8)
    expect(s.changePercent).toBeCloseTo(0.5 / 11 * 100, 8)
    expect(s.rangeHigh).toBe(13)
    expect(s.highTime).toBe(3000)
    expect(s.rangeLow).toBe(10)
    expect(s.lowTime).toBe(2000)
    expect(s.amplitudePercent).toBeCloseTo((13 - 10) / 11 * 100, 8)
    expect(s.volume).toBe(200 + 300 + 400)
    // idx1 前收 10.5 → 收 11 涨；idx2 前收 11 → 收 12.5 涨；idx3 前收 12.5 → 收 11.5 跌。
    expect(s.upBars).toBe(2)
    expect(s.downBars).toBe(1)
  })

  it('start/end 倒序与越界自动钳位交换；区间首根无前根时以开盘价为参照', () => {
    const stats = computeRangeStats(KLINES, 99, 0)
    expect(stats).not.toBeNull()
    const s = stats!
    expect(s.bars).toBe(KLINES.length)
    expect(s.startTime).toBe(1000)
    expect(s.endTime).toBe(5000)
    // 基准 = idx0 收盘 10.5；末根 10.4。
    expect(s.changePercent).toBeCloseTo((10.4 - 10.5) / 10.5 * 100, 8)
    // idx0 无前收 → 参照开盘 10，收 10.5 → 上涨根。
    expect(s.upBars).toBeGreaterThanOrEqual(1)
  })

  it('区间外单点 → null；空数据 → null', () => {
    expect(computeRangeStats(KLINES, -5, -2)).toBeNull()
    expect(computeRangeStats([], 0, 1)).toBeNull()
  })

  it('零/负基准（异常数据）→ null', () => {
    expect(computeRangeStats([bar(1000, 0, 0, 0, 0)], 0, 0)).toBeNull()
  })
})
