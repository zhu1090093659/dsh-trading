/**
 * 格式化与涨跌幅纯函数单测。
 */
import { describe, expect, it } from 'vitest'
import {
  changePercent, directionColor, fmtChange, fmtCompact, fmtCountdown, fmtFundingRate, fmtPercent, fmtPrice,
} from '../src/client/format.ts'

describe('fmtPrice', () => {
  it('按量级取小数位；undefined → —', () => {
    expect(fmtPrice(346.59)).toBe('346.59')
    expect(fmtPrice(0.123456)).toBe('0.1235')
    expect(fmtPrice(0.001234)).toBe('0.001234')
    expect(fmtPrice(undefined)).toBe('—')
    expect(fmtPrice(Number.NaN)).toBe('—')
  })
})

describe('fmtPercent / fmtChange', () => {
  it('带符号', () => {
    expect(fmtPercent(1.742)).toBe('+1.74%')
    expect(fmtPercent(-0.8)).toBe('-0.80%')
    expect(fmtPercent(0)).toBe('0.00%')
    expect(fmtChange(1.234)).toBe('+1.23')
    expect(fmtChange(-2)).toBe('-2.00')
  })
})

describe('fmtCompact', () => {
  it('万/亿 缩写', () => {
    expect(fmtCompact(123)).toBe('123')
    expect(fmtCompact(25_300)).toBe('2.53万')
    expect(fmtCompact(4_500_000_000)).toBe('45亿')
    expect(fmtCompact(undefined)).toBe('—')
  })
})

describe('directionColor（红涨绿跌）', () => {
  it('>0 红，<0 绿，0 灰', () => {
    expect(directionColor(0.1)).toBe('#e64545')
    expect(directionColor(-0.1)).toBe('#2ba471')
    expect(directionColor(0)).toBe('#8a8f99')
  })
})

describe('changePercent', () => {
  it('(price-ref)/ref*100；无效引用 → undefined', () => {
    expect(changePercent(110, 100)).toBeCloseTo(10)
    expect(changePercent(90, 100)).toBeCloseTo(-10)
    expect(changePercent(undefined, 100)).toBeUndefined()
    expect(changePercent(100, undefined)).toBeUndefined()
    expect(changePercent(100, 0)).toBeUndefined()
  })
})

/** issue #54：结算倒计时与资金费率格式。 */
describe('fmtCountdown / fmtFundingRate', () => {
  it('>1h 显示 h+m；<1h 显示 m+s；过期/缺省 → undefined', () => {
    const now = 1700000000000
    expect(fmtCountdown(now + (7 * 3600 + 32 * 60) * 1000, now)).toBe('7h 32m')
    expect(fmtCountdown(now + (32 * 60 + 10) * 1000, now)).toBe('32m 10s')
    expect(fmtCountdown(now - 1000, now)).toBeUndefined()
    expect(fmtCountdown(undefined, now)).toBeUndefined()
    expect(fmtCountdown(Number.NaN, now)).toBeUndefined()
  })

  it('小数费率 → 4 位百分比；缺省 → —', () => {
    expect(fmtFundingRate(0.0001)).toBe('0.0100%')
    expect(fmtFundingRate(-0.00002911)).toBe('-0.0029%')
    expect(fmtFundingRate(undefined)).toBe('—')
  })
})
