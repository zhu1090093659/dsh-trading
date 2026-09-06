/**
 * 持仓回合撮合引擎单测（2026-09-06 已实现盈亏）：
 * FIFO 逐批撮合、单回合多段平仓累加、多回合拆分、最新在前存储序、
 * 流水不完整（历史窗口外卖出）、按标的分组与排序、USD→基准币折算。
 */
import { describe, expect, it } from 'vitest'
import { convertUsdToBase, derivePositionRounds } from '../src/client/position-rounds.ts'
import type { RoundFillLike } from '../src/client/position-rounds.ts'

function fill(overrides: Partial<RoundFillLike> & Pick<RoundFillLike, 'symbol' | 'side' | 'price' | 'amount' | 'timestamp'>): RoundFillLike {
  return { ...overrides }
}

describe('derivePositionRounds 单回合', () => {
  it('一次开一次平：盈亏、均价、回合边界正确', () => {
    const out = derivePositionRounds([
      fill({ symbol: 'AAPL', side: 'buy', price: 100, amount: 10, timestamp: 1000 }),
      fill({ symbol: 'AAPL', side: 'sell', price: 110, amount: 10, timestamp: 2000 }),
    ])
    expect(out.rounds).toHaveLength(1)
    const r = out.rounds[0]!
    expect(r.openTs).toBe(1000)
    expect(r.closeTs).toBe(2000)
    expect(r.closedSize).toBe(10)
    expect(r.avgEntry).toBe(100)
    expect(r.avgExit).toBe(110)
    expect(r.realizedPnl).toBe(100) // (110-100)×10
    expect(out.totalRealizedPnl).toBe(100)
    expect(out.totalRealizedCost).toBe(1000)
  })

  it('回合内多段平仓：已实现盈亏累加进同一回合（0→0 区段）', () => {
    // 买10@100 → 卖4@120 → 买6@105 → 卖12@110（FIFO：6@100+6@105）
    const out = derivePositionRounds([
      fill({ symbol: 'P', side: 'buy', price: 100, amount: 10, timestamp: 1000 }),
      fill({ symbol: 'P', side: 'sell', price: 120, amount: 4, timestamp: 1100 }),
      fill({ symbol: 'P', side: 'buy', price: 105, amount: 6, timestamp: 1200 }),
      fill({ symbol: 'P', side: 'sell', price: 110, amount: 12, timestamp: 1300 }),
    ])
    expect(out.rounds).toHaveLength(1)
    const r = out.rounds[0]!
    expect(r.realizedPnl).toBe(170) // (120-100)×4 + (110-100)×6 + (110-105)×6
    expect(r.closedSize).toBe(16)
    expect(r.avgEntry).toBeCloseTo((1000 + 630) / 16, 6)
    expect(r.avgExit).toBeCloseTo((480 + 1320) / 16, 6)
    expect(r.closeTs).toBe(1300)
  })

  it('平仓后再开仓：拆成两个独立回合，各自盈亏可回看', () => {
    const out = derivePositionRounds([
      fill({ symbol: 'BTCUSDT', side: 'buy', price: 90_000, amount: 1, timestamp: 1000 }),
      fill({ symbol: 'BTCUSDT', side: 'sell', price: 100_000, amount: 1, timestamp: 1100 }),
      fill({ symbol: 'BTCUSDT', side: 'buy', price: 105_000, amount: 2, timestamp: 2000 }),
      fill({ symbol: 'BTCUSDT', side: 'sell', price: 103_000, amount: 2, timestamp: 2100 }),
    ])
    expect(out.rounds).toHaveLength(2)
    expect(out.rounds[0]?.realizedPnl).toBe(10_000)
    expect(out.rounds[1]?.realizedPnl).toBe(-4_000)
    expect(out.totalRealizedPnl).toBe(6_000)
    expect(out.totalRealizedCost).toBe(90_000 + 210_000)
    // 未平仓的买入不产生回合
    const openOnly = derivePositionRounds([fill({ symbol: 'X', side: 'buy', price: 5, amount: 1, timestamp: 1 })])
    expect(openOnly.rounds).toEqual([])
    expect(openOnly.bySymbol).toEqual([])
  })
})

describe('derivePositionRounds 输入序与分组', () => {
  it('paper 存储序（最新在前）也能正确撮合：内部按时间稳定排序', () => {
    const out = derivePositionRounds([
      fill({ symbol: 'S', side: 'sell', price: 110, amount: 10, timestamp: 2000 }),
      fill({ symbol: 'S', side: 'buy', price: 100, amount: 10, timestamp: 1000 }),
    ])
    expect(out.rounds[0]?.realizedPnl).toBe(100)
    expect(out.rounds[0]?.openTs).toBe(1000)
  })

  it('按标的分组：盈亏合计、最近平仓标的前置、market 取最后一笔带 market 的流水', () => {
    const out = derivePositionRounds([
      fill({ symbol: 'AAA', side: 'buy', price: 10, amount: 5, timestamp: 1000 }),
      fill({ symbol: 'AAA', side: 'sell', price: 12, amount: 5, timestamp: 1500 }), // +10
      fill({ symbol: 'BBB', side: 'buy', price: 100, amount: 1, timestamp: 2000, market: 'us' }),
      fill({ symbol: 'BBB', side: 'sell', price: 90, amount: 1, timestamp: 2500 }), // -10
      fill({ symbol: 'AAA', side: 'buy', price: 11, amount: 5, timestamp: 3000 }),
      fill({ symbol: 'AAA', side: 'sell', price: 13, amount: 5, timestamp: 3500, market: 'cn' }), // +10
    ])
    expect(out.bySymbol.map(h => h.key)).toEqual(['AAA', 'BBB']) // AAA 最近平仓在前
    const aaa = out.bySymbol[0]!
    expect(aaa.rounds).toHaveLength(2)
    expect(aaa.realizedPnl).toBe(20)
    expect(aaa.realizedCost).toBe(50 + 55)
    expect(aaa.lastCloseTs).toBe(3500)
    expect(aaa.market).toBe('cn') // 该组最后一笔带 market 的流水
    expect(out.bySymbol[1]?.market).toBe('us')
  })

  it('流水不完整（历史窗口外买入）：匹配不到成本批次的部分不计盈亏与平仓量', () => {
    const out = derivePositionRounds([
      fill({ symbol: 'H', side: 'buy', price: 50, amount: 5, timestamp: 1000 }),
      fill({ symbol: 'H', side: 'sell', price: 60, amount: 8, timestamp: 1100 }),
    ])
    expect(out.rounds).toHaveLength(1)
    const r = out.rounds[0]!
    expect(r.closedSize).toBe(5) // 只有 5 股匹配到成本批次
    expect(r.realizedPnl).toBe(50) // (60-50)×5
    expect(r.avgExit).toBe(60)
  })

  it('空流水 → 空结果', () => {
    const out = derivePositionRounds([])
    expect(out.rounds).toEqual([])
    expect(out.bySymbol).toEqual([])
    expect(out.totalRealizedPnl).toBe(0)
    expect(out.totalRealizedCost).toBe(0)
  })
})

describe('convertUsdToBase', () => {
  it('USD 基准恒等；其他基准按 rates.USD；缺席/缺汇率 → undefined', () => {
    expect(convertUsdToBase(100, { base: 'USD', rates: {} })).toBe(100)
    expect(convertUsdToBase(100, { base: 'CNY', rates: { USD: 7.2 } })).toBeCloseTo(720, 6)
    expect(convertUsdToBase(100, { base: 'CNY', rates: {} })).toBeUndefined()
    expect(convertUsdToBase(100, undefined)).toBeUndefined()
  })
})
