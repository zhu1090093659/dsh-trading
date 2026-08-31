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
    const [upOutput, dnOutput] = definition.compute(bars, { period: 10, mult: 3 })
    expect(upOutput).toBeDefined()
    expect(dnOutput).toBeDefined()
    expect(upOutput!.kind).toBe('area')
    expect(dnOutput!.kind).toBe('area')
    expect(upOutput!.values).toHaveLength(bars.length)
    expect(dnOutput!.values).toHaveLength(bars.length)
    expect(upOutput!.values.slice(0, 10).every(value => value === undefined)).toBe(true)
    expect(upOutput!.values[10]).toBeDefined()
  })

  it('上涨段 UP 趋势线低于收盘，跌破后翻转为 DN 阻力线并高于收盘', () => {
    const definition = supertrendDefinition()
    // 先涨 30 根后急跌 10 根。
    const bars = Array.from({ length: 40 }, (_, index) => {
      const close = index < 30 ? 100 + index : 130 - (index - 29) * 3
      return { openTime: index, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1 }
    })
    const [upOutput, dnOutput] = definition.compute(bars, { period: 5, mult: 2 })
    const upValue = upOutput!.values[25]!
    expect(upValue).toBeLessThan(bars[25]!.close)
    expect(dnOutput!.values[25]).toBeUndefined()

    const downValue = dnOutput!.values[39]!
    expect(downValue).toBeGreaterThan(bars[39]!.close)
    expect(upOutput!.values[39]).toBeUndefined()
  })
})
