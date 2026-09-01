import { describe, expect, it } from 'vitest'
import { parseStrategyBacktestPayload, parseStrategyAuthorText } from '../src/client/toolview-parse.ts'

describe('parseStrategyBacktestPayload', () => {
  it('parses a full ok payload', () => {
    const wire = JSON.stringify({
      ok: true,
      strategy: { id: 'donchian-breakout', name: '唐奇安突破', horizon: 'short' },
      market: 'crypto',
      symbol: 'BTCUSDT',
      interval: '1d',
      barsTested: 300,
      metrics: {
        totalReturn: 12.34, cagr: 15.2, maxDrawdown: -8.1, sharpe: 1.2,
        winRate: 55.5, profitFactor: 1.8, tradeCount: 12, exposure: 62.5,
      },
      equity: [{ time: 1, equity: 100000 }, { time: 2, equity: 101000 }, { time: 3, equity: 112340 }],
      initialCapital: 100000,
      finalCapital: 112340,
    })
    const parsed = parseStrategyBacktestPayload(wire)
    expect(parsed).not.toBeNull()
    expect(parsed?.name).toBe('唐奇安突破')
    expect(parsed?.symbol).toBe('BTCUSDT')
    expect(parsed?.totalReturn).toBeCloseTo(12.34)
    expect(parsed?.equityValues).toEqual([100000, 101000, 112340])
    expect(parsed?.isPositive).toBe(true)
  })

  it('drops bad equity points but keeps the rest', () => {
    const wire = JSON.stringify({
      ok: true,
      metrics: { totalReturn: -1 },
      equity: [{ equity: 100 }, { equity: 'bad' }, { equity: 90 }, {}, null],
    })
    const parsed = parseStrategyBacktestPayload(wire)
    expect(parsed?.equityValues).toEqual([100, 90])
    expect(parsed?.isPositive).toBe(false)
  })

  it('returns null for non-ok / non-JSON / empty', () => {
    expect(parseStrategyBacktestPayload(JSON.stringify({ ok: false }))).toBeNull()
    expect(parseStrategyBacktestPayload('not json')).toBeNull()
    expect(parseStrategyBacktestPayload('')).toBeNull()
    expect(parseStrategyBacktestPayload(undefined)).toBeNull()
    expect(parseStrategyBacktestPayload(42)).toBeNull()
  })
})

describe('parseStrategyAuthorText', () => {
  it('parses success with params', () => {
    const text = '[strategy_author] Successfully authored strategy "双均线止损止盈" (id: dual-ma, horizon: swing, params: fast=20, slow=60). The strategy passed sandbox trials…'
    const parsed = parseStrategyAuthorText(text)
    expect(parsed?.ok).toBe(true)
    expect(parsed?.title).toBe('双均线止损止盈')
    expect(parsed?.id).toBe('dual-ma')
    expect(parsed?.horizon).toBe('swing')
    expect(parsed?.params).toBe('fast=20, slow=60')
  })

  it('parses success without params', () => {
    const parsed = parseStrategyAuthorText('[strategy_author] Successfully authored strategy "X" (id: x, horizon: long).')
    expect(parsed?.ok).toBe(true)
    expect(parsed?.params).toBe('')
  })

  it('parses failure reason', () => {
    const parsed = parseStrategyAuthorText('[strategy_author] Validation failed: signals must start with entry\nReview the requirements: …')
    expect(parsed?.ok).toBe(false)
    expect(parsed?.reason).toContain('signals must start with entry')
  })

  it('returns null for other text', () => {
    expect(parseStrategyAuthorText('hello')).toBeNull()
    expect(parseStrategyAuthorText(undefined)).toBeNull()
  })
})