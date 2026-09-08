/**
 * intraday-series 纯函数单测：分钟候选粒度（crypto 固定 5m / 股票 1m→5m 自适应）、
 * 取数上限，与「最后一根 bar 的市场本地交易日」筛选语义——周末/节假日无需日历即回落最近交易日。
 */
import { describe, expect, it } from 'vitest'
import { intradayCandidates, intradayRequest, selectIntradayCloses, selectIntradaySeries, sessionXFraction } from '../src/client/intraday-series.ts'
import type { Kline } from '../src/client/types.ts'

function bar(openTime: number, close: number): Kline {
  return { openTime, open: close, high: close, low: close, close, volume: 0, closeTime: openTime + 60_000 }
}

describe('intradayCandidates / intradayRequest', () => {
  it('crypto 固定 5m×288 滚动 24h', () => {
    expect(intradayCandidates('crypto')).toEqual(['5m'])
    expect(intradayRequest('crypto', '5m')).toEqual({ interval: '5m', limit: 288 })
  })
  it('股票候选 1m→5m（腾讯 A 股无 1m 的实证兜底）', () => {
    for (const m of ['us', 'cn', 'hk'] as const) {
      expect(intradayCandidates(m)).toEqual(['1m', '5m'])
    }
    expect(intradayRequest('us', '1m')).toEqual({ interval: '1m', limit: 500 })
    expect(intradayRequest('cn', '5m')).toEqual({ interval: '5m', limit: 200 })
  })
})

describe('selectIntradayCloses', () => {
  it('空序列 → 空', () => {
    expect(selectIntradayCloses('us', [])).toEqual([])
  })

  it('crypto 不按日分组：入序列 close 原样返回（滚动窗口由调用方截尾）', () => {
    const klines = [bar(Date.UTC(2026, 8, 7, 22, 0), 1), bar(Date.UTC(2026, 8, 8, 1, 0), 2)]
    expect(selectIntradayCloses('crypto', klines)).toEqual([1, 2])
  })

  it('us 按纽约本地日筛选：只保留最后一根 bar 所在交易日的 bar', () => {
    // 2026-09-04 是周五。13:30Z=9:30 ET（开盘）、20:00Z=16:00 ET（收盘）；
    // 前一根是周四（2026-09-03）的收盘 bar，应被剔除。
    const klines = [
      bar(Date.UTC(2026, 8, 3, 20, 0), 100),
      bar(Date.UTC(2026, 8, 4, 13, 30), 101),
      bar(Date.UTC(2026, 8, 4, 16, 0), 102),
      bar(Date.UTC(2026, 8, 4, 20, 0), 103),
    ]
    expect(selectIntradayCloses('us', klines)).toEqual([101, 102, 103])
  })

  it('非交易日语义：最后一根 bar 落在周五时自然得到周五全天（无需节假日历）', () => {
    // 2026-09-07 是美国劳动节休市：周二看盘时上游最近 1m 数据停在周五，筛选结果即最近交易日。
    const klines = [
      bar(Date.UTC(2026, 8, 3, 19, 0), 50),
      bar(Date.UTC(2026, 8, 4, 19, 0), 51),
      bar(Date.UTC(2026, 8, 4, 19, 1), 52),
    ]
    expect(selectIntradayCloses('us', klines)).toEqual([51, 52])
  })

  it('跨时区不串日：cn 按上海本地日分组', () => {
    // A股收盘 15:00 CST = 07:00Z；前一日收盘与当日 bar 必须分开。
    const klines = [
      bar(Date.UTC(2026, 8, 7, 7, 0), 10),
      bar(Date.UTC(2026, 8, 8, 1, 30), 11),
      bar(Date.UTC(2026, 8, 8, 7, 0), 12),
    ]
    expect(selectIntradayCloses('cn', klines)).toEqual([11, 12])
  })

  it('hk 按香港本地日分组', () => {
    const klines = [
      bar(Date.UTC(2026, 8, 7, 8, 0), 20),
      bar(Date.UTC(2026, 8, 8, 2, 0), 21),
    ]
    expect(selectIntradayCloses('hk', klines)).toEqual([21])
  })
})

describe('sessionXFraction（固定交易时段 x 轴）', () => {
  // 2026-09 期间 ET=UTC-4（EDT）、CST/HKT=UTC+8
  it('crypto 无时段概念 → null', () => {
    expect(sessionXFraction('crypto', Date.UTC(2026, 8, 8, 2, 0))).toBeNull()
  })
  it('us：9:30 ET→0，12:45 ET→0.5，16:00 ET→1，盘前钳 0', () => {
    expect(sessionXFraction('us', Date.UTC(2026, 8, 4, 13, 30))).toBe(0)
    expect(sessionXFraction('us', Date.UTC(2026, 8, 4, 16, 45))).toBeCloseTo(0.5)
    expect(sessionXFraction('us', Date.UTC(2026, 8, 4, 20, 0))).toBe(1)
    expect(sessionXFraction('us', Date.UTC(2026, 8, 4, 12, 0))).toBe(0) // 8:00 ET 盘前
  })
  it('cn：10:30→0.25，午休钳到上午收盘 0.5，13:30→0.625，15:00→1', () => {
    expect(sessionXFraction('cn', Date.UTC(2026, 8, 8, 2, 30))).toBeCloseTo(0.25)
    expect(sessionXFraction('cn', Date.UTC(2026, 8, 8, 3, 40))).toBeCloseTo(0.5) // 11:40 午休
    expect(sessionXFraction('cn', Date.UTC(2026, 8, 8, 5, 30))).toBeCloseTo(0.625)
    expect(sessionXFraction('cn', Date.UTC(2026, 8, 8, 7, 0))).toBe(1)
  })
  it('hk：10:30→60/330，午休钳到 150/330，14:00→210/330，16:00→1', () => {
    expect(sessionXFraction('hk', Date.UTC(2026, 8, 8, 2, 30))).toBeCloseTo(60 / 330)
    expect(sessionXFraction('hk', Date.UTC(2026, 8, 8, 4, 30))).toBeCloseTo(150 / 330) // 12:30 午休
    expect(sessionXFraction('hk', Date.UTC(2026, 8, 8, 6, 0))).toBeCloseTo(210 / 330)
    expect(sessionXFraction('hk', Date.UTC(2026, 8, 8, 8, 0))).toBe(1)
  })
})

describe('selectIntradaySeries', () => {
  it('us：返回 closes + 固定时段 xFractions（上午未完成时最右点 < 1）', () => {
    const klines = [
      bar(Date.UTC(2026, 8, 3, 20, 0), 100), // 前一日收盘 bar，应剔除
      bar(Date.UTC(2026, 8, 4, 13, 30), 101), // 9:30 ET → x=0
      bar(Date.UTC(2026, 8, 4, 16, 30), 102), // 12:30 ET → x=180/390
    ]
    const picked = selectIntradaySeries('us', klines)
    expect(picked.closes).toEqual([101, 102])
    expect(picked.xFractions).toHaveLength(2)
    expect(picked.xFractions?.[0]).toBe(0)
    expect(picked.xFractions?.[1]).toBeCloseTo(180 / 390)
    expect(picked.xFractions?.[1]).toBeLessThan(1) // 盘中语义：未铺满
  })
  it('crypto：不返回 xFractions（滚动窗口等距）', () => {
    const picked = selectIntradaySeries('crypto', [bar(Date.UTC(2026, 8, 8, 1, 0), 1), bar(Date.UTC(2026, 8, 8, 1, 5), 2)])
    expect(picked.closes).toEqual([1, 2])
    expect(picked.xFractions).toBeUndefined()
  })
})
