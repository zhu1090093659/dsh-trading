/**
 * 图表布局纯函数单测：SMA 暖 Undefined、可见窗口切片、极值填充、退化输入。
 */
import { describe, expect, it } from 'vitest'
import type { Kline } from '../src/client/types.ts'
import { AXIS_W, MIN_SLOT, computeCandleLayout, priceY, sma, volumeH } from '../src/client/chart-layout.ts'

function kline(index: number): Kline {
  const close = 100 + index
  return { openTime: index * 86400000, open: close - 1, high: close + 2, low: close - 2, close, volume: index + 1, closeTime: index * 86400000 + 86399999 }
}

describe('sma', () => {
  it('暖期 undefined，之后为均值', () => {
    const out = sma([1, 2, 3, 4, 5], 3)
    expect(out).toEqual([undefined, undefined, 2, 3, 4])
  })

  it('样本不足全 undefined', () => {
    expect(sma([1, 2], 5)).toEqual([undefined, undefined])
  })
})

describe('computeCandleLayout', () => {
  it('宽度不足 → null（不可绘制）', () => {
    expect(computeCandleLayout([kline(0)], 10, 400)).toBeNull()
    expect(computeCandleLayout([], 800, 400)).toBeNull()
  })

  it('可见窗口受宽度约束且不超过样本数', () => {
    const klines = Array.from({ length: 300 }, (_, i) => kline(i))
    const layout = computeCandleLayout(klines, 800, 400)
    expect(layout).not.toBeNull()
    const visibleN = layout?.visible.length ?? 0
    expect(visibleN).toBe(Math.min(300, Math.floor((800 - AXIS_W) / MIN_SLOT)))
    expect(layout?.slot).toBeCloseTo((800 - AXIS_W) / visibleN, 5)
  })

  it('极值含 5% 填充；平盘序列保持可见带宽', () => {
    const flat = Array.from({ length: 40 }, (_, i) => ({ ...kline(i), open: 100, high: 100, low: 100, close: 100 }))
    const layout = computeCandleLayout(flat, 800, 400)
    expect(layout?.priceMin).toBeLessThan(100)
    expect(layout?.priceMax).toBeGreaterThan(100)
  })

  it('MA 对齐可见窗口（尾部切片）', () => {
    const klines = Array.from({ length: 60 }, (_, i) => kline(i))
    const layout = computeCandleLayout(klines, 800, 400, [5])
    const values = layout?.maSeries[0]?.values ?? []
    expect(values).toHaveLength(layout?.visible.length ?? 0)
    const last = values[values.length - 1]
    const closes = klines.slice(-5).map(candle => candle.close)
    expect(last).toBeCloseTo(closes.reduce((a, b) => a + b, 0) / 5, 8)
  })

  it('priceY/volumeH 单调且在面板内', () => {
    const klines = Array.from({ length: 40 }, (_, i) => kline(i))
    const layout = computeCandleLayout(klines, 800, 400)
    if (layout === null) throw new Error('layout expected')
    expect(priceY(layout.priceMin, layout)).toBeCloseTo(layout.priceH, 5)
    expect(priceY(layout.priceMax, layout)).toBeCloseTo(0, 5)
    expect(volumeH(layout.volMax, layout)).toBeCloseTo(layout.volH, 5)
    expect(volumeH(0, layout)).toBe(0)
  })
})
