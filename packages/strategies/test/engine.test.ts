import { describe, expect, it } from 'vitest'
import { run } from '../src/engine.ts'
import type { Kline, StrategyDefinition } from '../src/types.ts'

function createSampleKlines(): Kline[] {
  const baseTime = 1700000000000
  const day = 86400 * 1000
  // 构造 10 根确定性 K 线
  return [
    { openTime: baseTime, open: 100, high: 105, low: 95, close: 102, volume: 1000 },
    { openTime: baseTime + day, open: 103, high: 108, low: 101, close: 106, volume: 1100 },
    { openTime: baseTime + 2 * day, open: 107, high: 112, low: 105, close: 110, volume: 1200 },
    { openTime: baseTime + 3 * day, open: 111, high: 115, low: 109, close: 114, volume: 1300 },
    { openTime: baseTime + 4 * day, open: 113, high: 116, low: 108, close: 109, volume: 1400 },
    { openTime: baseTime + 5 * day, open: 108, high: 110, low: 102, close: 104, volume: 1500 },
    { openTime: baseTime + 6 * day, open: 103, high: 107, low: 100, close: 106, volume: 1200 },
    { openTime: baseTime + 7 * day, open: 107, high: 112, low: 106, close: 111, volume: 1300 },
    { openTime: baseTime + 8 * day, open: 110, high: 114, low: 108, close: 112, volume: 1100 },
    { openTime: baseTime + 9 * day, open: 111, high: 113, low: 105, close: 107, volume: 1000 },
  ]
}

describe('Strategy Engine', () => {
  it('handles empty bars gracefully', () => {
    const dummyStrategy: StrategyDefinition = {
      id: 'dummy',
      horizon: 'short',
      name: 'Dummy',
      summary: '',
      params: [],
      compute: () => [],
    }
    const result = run([], dummyStrategy)
    expect(result.signals).toHaveLength(0)
    expect(result.trades).toHaveLength(0)
    expect(result.equity).toHaveLength(0)
    expect(result.metrics.totalReturn).toBe(0)
    expect(result.metrics.tradeCount).toBe(0)
  })

  it('correctly executes buy at next open and sell at next open with fees', () => {
    const bars = createSampleKlines()

    // 假设在 index 1 产生 entry 信号，在 index 3 产生 exit 信号
    const mockStrategy: StrategyDefinition = {
      id: 'mock',
      horizon: 'short',
      name: 'Mock',
      summary: '',
      params: [],
      compute: (b) => [
        { index: 1, time: b[1].openTime, action: 'entry', direction: 'long', price: b[1].close, reason: 'buy signal' },
        { index: 3, time: b[3].openTime, action: 'exit', direction: 'flat', price: b[3].close, reason: 'sell signal' },
      ],
    }

    const initialCapital = 100000
    const feeRate = 0.001
    const result = run(bars, mockStrategy, {}, { initialCapital, feeRate, slippage: 0 })

    expect(result.signals).toHaveLength(2)
    expect(result.trades).toHaveLength(1)

    const trade = result.trades[0]
    expect(trade).toBeDefined()
    // 成交在 index 2 的 open: 107
    expect(trade?.entryIndex).toBe(2)
    expect(trade?.entryPrice).toBe(107)
    // 卖出在 index 4 的 open: 113
    expect(trade?.exitIndex).toBe(4)
    expect(trade?.exitPrice).toBe(113)
    expect(trade?.holdingBars).toBe(2)
    expect(trade?.exitReason).toBe('sell signal')

    // 验证收益率与最终净值：买入价 107，卖出价 113
    // cost = 107 * 1.001 = 107.107; shares = 100000 / 107.107; gross = shares * 113; net = gross * 0.999
    const expectedReturn = ((113 / 107) * (0.999 / 1.001) - 1) * 100
    expect(trade?.returnPercent).toBeCloseTo(expectedReturn, 4)
    expect(result.metrics.tradeCount).toBe(1)
    expect(result.metrics.winRate).toBe(100)
    expect(result.metrics.profitFactor).toBe(Infinity)
    expect(result.metrics.totalReturn).toBeCloseTo(expectedReturn, 4)
    expect(result.metrics.exposure).toBe((2 / 10) * 100)
  })

  it('ignores signal on the very last bar (cannot execute on next bar)', () => {
    const bars = createSampleKlines()
    const lastIdx = bars.length - 1

    const lastBarStrategy: StrategyDefinition = {
      id: 'last_bar',
      horizon: 'short',
      name: 'Last Bar',
      summary: '',
      params: [],
      compute: (b) => [
        { index: lastIdx, time: b[lastIdx].openTime, action: 'entry', direction: 'long', price: b[lastIdx].close, reason: 'late buy' },
      ],
    }

    const result = run(bars, lastBarStrategy)
    expect(result.signals).toHaveLength(1)
    expect(result.trades).toHaveLength(0)
    expect(result.finalCapital).toBe(100000)
  })
})
