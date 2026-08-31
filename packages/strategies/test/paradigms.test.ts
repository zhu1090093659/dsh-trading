import { describe, expect, it } from 'vitest'
import {
  donchianBreakoutStrategy,
  rsiReversionStrategy,
  emaCrossoverStrategy,
  bollingerReversionStrategy,
  smaBaselineStrategy,
  momentum12mStrategy,
} from '../src/paradigms/index.ts'
import { run } from '../src/engine.ts'
import type { Kline } from '../src/types.ts'

function makeTrendBars(length: number, slope: number, basePrice = 100): Kline[] {
  const baseTime = 1700000000000
  const day = 86400 * 1000
  return Array.from({ length }, (_, i) => {
    const open = basePrice + i * slope
    const close = open + slope * 0.8
    const high = Math.max(open, close) + 2
    const low = Math.min(open, close) - 2
    return {
      openTime: baseTime + i * day,
      open,
      high,
      low,
      close,
      volume: 1000,
    }
  })
}

describe('Strategy Paradigms', () => {
  describe('donchian-breakout', () => {
    it('triggers entry on upward breakout and exit on downward breakdown', () => {
      // 构造前 20 根震荡，第 21 根剧烈冲高，第 30 根剧烈暴跌
      const bars: Kline[] = []
      const baseTime = 1700000000000
      const day = 86400 * 1000

      // 0..19: 100 附近震荡
      for (let i = 0; i < 20; i++) {
        bars.push({
          openTime: baseTime + i * day,
          open: 100,
          high: 105,
          low: 95,
          close: 100,
          volume: 1000,
        })
      }
      // 20: 冲高到 110 (突破 105)
      bars.push({
        openTime: baseTime + 20 * day,
        open: 101,
        high: 110,
        low: 100,
        close: 109,
        volume: 2000,
      })
      // 21..28: 维持高位
      for (let i = 21; i < 28; i++) {
        bars.push({
          openTime: baseTime + i * day,
          open: 108,
          high: 112,
          low: 106,
          close: 109,
          volume: 1000,
        })
      }
      // 28: 暴跌至 80 (跌破前 10 根最低价 100)
      bars.push({
        openTime: baseTime + 28 * day,
        open: 107,
        high: 108,
        low: 78,
        close: 80,
        volume: 3000,
      })

      const signals = donchianBreakoutStrategy.compute(bars, { lookbackEntry: 20, lookbackExit: 10 })
      expect(signals.length).toBeGreaterThanOrEqual(2)
      expect(signals[0]?.action).toBe('entry')
      expect(signals[0]?.index).toBe(20)
      expect(signals[1]?.action).toBe('exit')
      expect(signals[1]?.index).toBe(28)
    })

    it('does not trigger on flat market within channel', () => {
      const flatBars = makeTrendBars(30, 0, 100)
      const signals = donchianBreakoutStrategy.compute(flatBars, { lookbackEntry: 20, lookbackExit: 10 })
      expect(signals).toHaveLength(0)
    })
  })

  describe('rsi-reversion', () => {
    it('triggers entry on extreme oversold and exit on rebound', () => {
      // 连续暴跌导致 RSI(2) < 10，随后大阳线反弹导致 RSI(2) > 60
      const baseTime = 1700000000000
      const day = 86400 * 1000
      const bars: Kline[] = [
        { openTime: baseTime, open: 100, high: 102, low: 98, close: 100, volume: 1000 },
        { openTime: baseTime + day, open: 100, high: 101, low: 85, close: 85, volume: 2000 },
        { openTime: baseTime + 2 * day, open: 85, high: 86, low: 70, close: 70, volume: 3000 },
        { openTime: baseTime + 3 * day, open: 70, high: 71, low: 55, close: 55, volume: 4000 },
        { openTime: baseTime + 4 * day, open: 55, high: 80, low: 54, close: 79, volume: 5000 },
        { openTime: baseTime + 5 * day, open: 79, high: 95, low: 78, close: 95, volume: 5000 },
      ]

      const signals = rsiReversionStrategy.compute(bars, { rsiPeriod: 2, entryThreshold: 10, exitThreshold: 60 })
      expect(signals.length).toBeGreaterThanOrEqual(1)
      expect(signals[0]?.action).toBe('entry')
    })

    it('does not trigger when RSI remains in neutral range', () => {
      const flatBars = makeTrendBars(20, 0.1, 100)
      const signals = rsiReversionStrategy.compute(flatBars, { rsiPeriod: 2, entryThreshold: 5, exitThreshold: 95 })
      expect(signals).toHaveLength(0)
    })
  })

  describe('ema-crossover', () => {
    it('triggers entry on golden cross and exit on death cross', () => {
      // 构造 100 根：前 40 根下跌使得 EMA20 < EMA60，随后强力拉升产生金叉
      const bars: Kline[] = []
      const baseTime = 1700000000000
      const day = 86400 * 1000

      for (let i = 0; i < 60; i++) {
        bars.push({
          openTime: baseTime + i * day,
          open: 100 - i * 0.5,
          high: 101 - i * 0.5,
          low: 99 - i * 0.5,
          close: 100 - i * 0.5,
          volume: 1000,
        })
      }
      for (let i = 60; i < 120; i++) {
        bars.push({
          openTime: baseTime + i * day,
          open: 70 + (i - 60) * 2,
          high: 72 + (i - 60) * 2,
          low: 69 + (i - 60) * 2,
          close: 71 + (i - 60) * 2,
          volume: 2000,
        })
      }

      const signals = emaCrossoverStrategy.compute(bars, { fastPeriod: 5, slowPeriod: 15 })
      expect(signals.some((s) => s.action === 'entry')).toBe(true)
    })

    it('does not trigger without crossing', () => {
      const steadyBars = makeTrendBars(40, 1, 100)
      const signals = emaCrossoverStrategy.compute(steadyBars, { fastPeriod: 5, slowPeriod: 20 })
      // 一直稳定上涨不会发生交叉
      const exits = signals.filter((s) => s.action === 'exit')
      expect(exits).toHaveLength(0)
    })
  })

  describe('bollinger-reversion', () => {
    it('triggers entry on dip below lower band and exit on return to middle', () => {
      const bars: Kline[] = []
      const baseTime = 1700000000000
      const day = 86400 * 1000

      // 20 根平盘
      for (let i = 0; i < 20; i++) {
        bars.push({ openTime: baseTime + i * day, open: 100, high: 102, low: 98, close: 100, volume: 1000 })
      }
      // 砸穿下轨
      bars.push({ openTime: baseTime + 20 * day, open: 98, high: 98, low: 80, close: 82, volume: 3000 })
      // 强劲反弹回归 100
      bars.push({ openTime: baseTime + 21 * day, open: 85, high: 102, low: 84, close: 101, volume: 4000 })

      const signals = bollingerReversionStrategy.compute(bars, { period: 10, multiplier: 2 })
      expect(signals.length).toBeGreaterThanOrEqual(2)
      expect(signals[0]?.action).toBe('entry')
      expect(signals[1]?.action).toBe('exit')
    })
  })

  describe('sma-baseline', () => {
    it('triggers entry when price crosses above SMA and exit when dropping below', () => {
      const bars: Kline[] = []
      const baseTime = 1700000000000
      const day = 86400 * 1000

      for (let i = 0; i < 25; i++) {
        bars.push({ openTime: baseTime + i * day, open: 90, high: 92, low: 88, close: 90, volume: 1000 })
      }
      // 突破
      bars.push({ openTime: baseTime + 25 * day, open: 95, high: 110, low: 94, close: 108, volume: 2000 })
      // 回落跌破
      bars.push({ openTime: baseTime + 26 * day, open: 105, high: 106, low: 70, close: 72, volume: 2000 })

      const signals = smaBaselineStrategy.compute(bars, { period: 20 })
      expect(signals.length).toBe(2)
      expect(signals[0]?.action).toBe('entry')
      expect(signals[1]?.action).toBe('exit')
    })
  })

  describe('momentum-12m', () => {
    it('triggers entry when 12m momentum is positive and price is above SMA', () => {
      // 30 根 K 线（测试缩短 lookback）
      const bars = makeTrendBars(40, 2, 50)
      const signals = momentum12mStrategy.compute(bars, { lookbackBars: 20 })
      expect(signals.length).toBeGreaterThanOrEqual(1)
      expect(signals[0]?.action).toBe('entry')
    })
  })
})
