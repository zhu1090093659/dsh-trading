/**
 * 内置选股器纯函数单测：确定性合成 K 线，正例命中 + 反例不命中 + 数据不足
 * 返回 null 三条线全覆盖（契约：evaluate 是无 IO 纯函数）。
 */
import { describe, expect, it } from 'vitest'
import type { Kline } from '@dshtrading/indicators'
import {
  screenerParadigms,
  getScreenerById,
  maBullAlignScreener,
  volumeBreakoutScreener,
  rsiOversoldScreener,
  nearHighScreener,
  aboveMaScreener,
} from '../src/screeners/index.ts'

/** 合成日 K：close 序列给定，high/low 各外扩 1%，量能统一。 */
function makeBars(closes: number[], volume = 1000): Kline[] {
  return closes.map((close, i) => ({
    openTime: 86_400_000 * i,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume,
  }))
}

/** 线性上行序列（等差 +1），dailyK 根。 */
function rising(n: number, start = 100): number[] {
  return Array.from({ length: n }, (_, i) => start + i)
}

/** 线性下行序列（等差 -1）。 */
function falling(n: number, start = 400): number[] {
  return Array.from({ length: n }, (_, i) => start - i)
}

describe('screener registry', () => {
  it('内置名册含 5 个选股器且 id 唯一', () => {
    expect(screenerParadigms).toHaveLength(5)
    expect(new Set(screenerParadigms.map((s) => s.id)).size).toBe(5)
    for (const id of ['scr.ma-bull-align', 'scr.volume-breakout', 'scr.rsi-oversold', 'scr.near-high', 'scr.above-ma']) {
      expect(getScreenerById(id)?.id).toBe(id)
    }
    expect(getScreenerById('nope')).toBeUndefined()
  })

  it('纯函数：同一输入同一输出', () => {
    const bars = makeBars(rising(140))
    const a = maBullAlignScreener.evaluate(bars, {})
    const b = maBullAlignScreener.evaluate(bars, {})
    expect(a).toEqual(b)
  })
})

describe('scr.ma-bull-align', () => {
  it('上行序列多头排列命中', () => {
    const match = maBullAlignScreener.evaluate(makeBars(rising(140)), {})
    expect(match).not.toBeNull()
    expect(match!.metrics.distLongPct).toBeGreaterThan(0)
    expect(match!.reason).toContain('多头排列')
  })

  it('下行序列不命中', () => {
    expect(maBullAlignScreener.evaluate(makeBars(falling(140)), {})).toBeNull()
  })

  it('数据不足返回 null（不算错误）', () => {
    expect(maBullAlignScreener.evaluate(makeBars(rising(100)), {})).toBeNull()
  })
})

describe('scr.volume-breakout', () => {
  const base = Array.from({ length: 30 }, () => 100)

  it('创新高 + 放量命中，量比与突破幅度正确', () => {
    const closes = [...base]
    closes[29] = 104
    const bars = makeBars(closes)
    bars[29] = { ...bars[29], high: 105, volume: 2500 }
    const match = volumeBreakoutScreener.evaluate(bars, {})
    expect(match).not.toBeNull()
    // 均量窗口含当根：avgVol = (19×1000 + 2500) / 20 = 1075
    expect(match!.metrics.volRatio).toBeCloseTo(2500 / 1075, 5)
    expect(match!.metrics.breakoutPct).toBeCloseTo(((104 - 101) / 101) * 100, 5)
  })

  it('创新高但无量不命中', () => {
    const closes = [...base]
    closes[29] = 104
    const bars = makeBars(closes)
    bars[29] = { ...bars[29], high: 105, volume: 1200 }
    expect(volumeBreakoutScreener.evaluate(bars, {})).toBeNull()
  })

  it('放量但未创新高不命中', () => {
    const closes = [...base]
    const bars = makeBars(closes)
    bars[29] = { ...bars[29], volume: 5000 }
    expect(volumeBreakoutScreener.evaluate(bars, {})).toBeNull()
  })
})

describe('scr.rsi-oversold', () => {
  it('连续下跌 RSI 触底命中', () => {
    const match = rsiOversoldScreener.evaluate(makeBars(falling(30)), {})
    expect(match).not.toBeNull()
    expect(match!.metrics.rsi).toBeLessThan(30)
  })

  it('连续上涨 RSI 满值不命中', () => {
    expect(rsiOversoldScreener.evaluate(makeBars(rising(30)), {})).toBeNull()
  })

  it('数据不足返回 null', () => {
    expect(rsiOversoldScreener.evaluate(makeBars(rising(10)), {})).toBeNull()
  })
})

describe('scr.near-high', () => {
  it('收在窗口高点附近命中', () => {
    const match = nearHighScreener.evaluate(makeBars(rising(250)), {})
    expect(match).not.toBeNull()
    // high 外扩 1%：offHigh ≈ 1% < 默认 5% 阈值
    expect(match!.metrics.offHighPct).toBeGreaterThan(0)
    expect(match!.metrics.offHighPct).toBeLessThanOrEqual(5)
  })

  it('距高点过远不命中', () => {
    const closes = rising(250)
    closes[249] = 150
    expect(nearHighScreener.evaluate(makeBars(closes), {})).toBeNull()
  })

  it('窗口不足一年跳过（防新上市误判）', () => {
    expect(nearHighScreener.evaluate(makeBars(rising(200)), {})).toBeNull()
  })
})

describe('scr.above-ma', () => {
  it('上行序列：站上牛熊线且斜率向上，命中', () => {
    const match = aboveMaScreener.evaluate(makeBars(rising(240)), {})
    expect(match).not.toBeNull()
    expect(match!.metrics.aboveMaPct).toBeGreaterThan(0)
    expect(match!.metrics.maSlopePct).toBeGreaterThan(0)
  })

  it('下行序列：价格与斜率双弱，不命中', () => {
    expect(aboveMaScreener.evaluate(makeBars(falling(240)), {})).toBeNull()
  })

  it('数据不足（period + slopeBars - 1）返回 null', () => {
    expect(aboveMaScreener.evaluate(makeBars(rising(200)), {})).toBeNull()
  })
})
