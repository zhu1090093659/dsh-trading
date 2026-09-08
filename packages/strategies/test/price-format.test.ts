/**
 * 标的价格显示小数位（自适应 2→3 位）纯函数单测。
 */
import { describe, expect, it } from 'vitest'
import { fmtPrice, priceDigits } from '../src/price-format.ts'

describe('priceDigits', () => {
  it('≥1 默认 2 位；2 位舍入丢第 3 位有效小数时升 3 位（港股 0.001 tick）', () => {
    expect(priceDigits(346.59)).toBe(2)
    expect(priceDigits(107.125)).toBe(3)
    expect(priceDigits(107.12)).toBe(2)
    expect(priceDigits(107)).toBe(2)
    expect(priceDigits(1043.125)).toBe(3)
  })

  it('<1 按量级 4/6 位；浮点噪声不触发升位；无效值回落 2', () => {
    expect(priceDigits(0.123456)).toBe(4)
    expect(priceDigits(0.001234)).toBe(6)
    expect(priceDigits(33.300000000000004)).toBe(2)
    expect(priceDigits(undefined)).toBe(2)
    expect(priceDigits(Number.NaN)).toBe(2)
  })
})

describe('fmtPrice', () => {
  it('按 priceDigits 定点舍入；无效值 → —', () => {
    expect(fmtPrice(107.125)).toBe('107.125')
    expect(fmtPrice(346.59)).toBe('346.59')
    expect(fmtPrice(0.123456)).toBe('0.1235')
    expect(fmtPrice(undefined)).toBe('—')
    expect(fmtPrice(Number.NaN)).toBe('—')
  })
})
