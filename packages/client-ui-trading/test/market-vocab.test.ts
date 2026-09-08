/**
 * 市场词汇小件单测（issue #82 审查补充）：无市场上下文的手输代码 → 市场推断与规范形归一。
 */
import { describe, expect, it } from 'vitest'
import { inferInputMarket, normalizeSymbolInput } from '../src/client/market-vocab.ts'

describe('inferInputMarket（自选管理添加框的市场推断）', () => {
  it('港股形态：裸数字 / 规范形 / Futu 原生形', () => {
    expect(inferInputMarket('700')).toBe('hk')
    expect(inferInputMarket('00700')).toBe('hk')
    expect(inferInputMarket('00700.HK')).toBe('hk')
    expect(inferInputMarket('hk.00700')).toBe('hk')
  })

  it('A 股 6 位数字（含 .SH/.SZ）→ cn', () => {
    expect(inferInputMarket('600519')).toBe('cn')
    expect(inferInputMarket('000001')).toBe('cn')
    expect(inferInputMarket('600519.SH')).toBe('cn')
  })

  it('加密计价标记 → crypto；其余 → us（此前恒落 crypto 是审查发现的错归）', () => {
    expect(inferInputMarket('btcusdt')).toBe('crypto')
    expect(inferInputMarket('ETHBTC')).toBe('crypto')
    expect(inferInputMarket('PLTR')).toBe('us')
    expect(inferInputMarket('BRK.B')).toBe('us')
  })
})

describe('normalizeSymbolInput', () => {
  it('港股三种输入形一律归一到规范形', () => {
    expect(normalizeSymbolInput('hk', '700')).toBe('00700.HK')
    expect(normalizeSymbolInput('hk', '00700.HK')).toBe('00700.HK')
    expect(normalizeSymbolInput('hk', 'HK.00700')).toBe('00700.HK')
  })

  it('A 股 6 位数字按首位推断交易所；非数字透传大写', () => {
    expect(normalizeSymbolInput('cn', '600519')).toBe('600519.SH')
    expect(normalizeSymbolInput('cn', '000001')).toBe('000001.SZ')
    expect(normalizeSymbolInput('us', 'aapl')).toBe('AAPL')
  })
})
