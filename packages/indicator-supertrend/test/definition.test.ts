/**
 * 超级趋势 definition 契约单测：输出与 K 线对齐、warm-up undefined、
 * 趋势翻转行为（人工小样本金值）。
 */
import { describe, expect, it } from 'vitest'
import { supertrendDefinition } from '../src/client/index.ts'

describe('supertrend definition', () => {
  it('输出与 K 线逐条对齐，warm-up 段 undefined', () => {
    const definition = supertrendDefinition()
    const bars = Array.from({ length: 40 }, (_, index) => ({
      openTime: index * 86400000,
      open: 100,
      high: 101,
      low: 99,
      close: 100 + index * 0.1,
      volume: 1,
    }))
    const [output] = definition.compute(bars, { period: 10, mult: 3 })
    expect(output).toBeDefined()
    expect(output!.values).toHaveLength(bars.length)
    expect(output!.values.slice(0, 10).every(value => value === undefined)).toBe(true)
    expect(output!.values[10]).toBeDefined()
  })

  it('上涨段趋势线低于收盘，跌破后翻转到上方', () => {
    const definition = supertrendDefinition()
    // 先涨 30 根后急跌 10 根。
    const bars = Array.from({ length: 40 }, (_, index) => {
      const close = index < 30 ? 100 + index : 130 - (index - 29) * 3
      return { openTime: index, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1 }
    })
    const [output] = definition.compute(bars, { period: 5, mult: 2 })
    const values = output!.values
    const upValue = values[25]!
    expect(upValue).toBeLessThan(bars[25]!.close)
    const downValue = values[39]!
    expect(downValue).toBeGreaterThan(bars[39]!.close)
  })
})
