/**
 * toolview 富卡片渲染测试（issue #34 / P5）：验证 parser→DOM 链路与
 * running/解析失败回落 null（不接管渲染）的契约。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { StrategyBacktestCard, StrategyAuthorCard } from '../src/client/toolview.tsx'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'

const OK_BACKTEST = JSON.stringify({
  ok: true,
  strategy: { id: 'donchian-breakout', name: '唐奇安突破', horizon: 'short' },
  market: 'crypto',
  symbol: 'BTCUSDT',
  interval: '1d',
  barsTested: 300,
  metrics: { totalReturn: 12.34, cagr: 15.2, maxDrawdown: -8.1, sharpe: 1.2, winRate: 55.5, profitFactor: 1.8, tradeCount: 12, exposure: 62.5 },
  equity: [{ time: 1, equity: 100000 }, { time: 2, equity: 105000 }, { time: 3, equity: 112340 }],
  initialCapital: 100000,
  finalCapital: 112340,
})

function block(kind: 'running' | 'result', payload?: string | Error): ToolCallOwnerProps['block'] {
  if (kind === 'running') {
    return {
      callId: 'c1', name: 'strategy_backtest', argsRaw: '{}', turn: 1, step: 1, time: 0, subCalls: [],
    }
  }
  if (payload instanceof Error) {
    return {
      kind: 'tool-result', seq: 1, time: 0, callId: 'c1', call: { name: 'strategy_backtest', argsRaw: '{}' },
      callTime: 0, content: [], isError: true, error: { name: 'Error', code: 'X' }, subCalls: [],
    }
  }
  return {
    kind: 'tool-result', seq: 1, time: 0, callId: 'c1', call: { name: 'strategy_backtest', argsRaw: '{}' },
    callTime: 0, content: [{ type: 'text', text: payload as string }], isError: false, subCalls: [],
  }
}

const owner = (blockValue: ToolCallOwnerProps['block']): ToolCallOwnerProps => ({
  callId: 'c1',
  toolName: 'strategy_backtest',
  block: blockValue,
  openFile: () => {},
} as unknown as ToolCallOwnerProps)

describe('StrategyBacktestCard', () => {
  it('renders head chips + 8 metrics + sparkline from a settled payload', () => {
    const { container } = render(<StrategyBacktestCard {...owner(block('result', OK_BACKTEST))} />)
    const card = container.querySelector('[data-dshtrading-toolview="strategy-backtest"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('唐奇安突破')
    expect(card?.textContent).toContain('BTCUSDT')
    // 8 指标 cell（metric cell = metricLabel + metricValue 对）
    expect(card?.querySelectorAll('[class*=metricLabel]')).toHaveLength(8)
    expect(card?.querySelectorAll('[class*=metricValue]')).toHaveLength(8)
    // sparkline polyline
    expect(card?.querySelector('svg polyline')).not.toBeNull()
  })

  it('returns null while running (falls back to generic tool row)', () => {
    const { container } = render(<StrategyBacktestCard {...owner(block('running'))} />)
    expect(container.querySelector('[data-dshtrading-toolview]')).toBeNull()
  })

  it('returns null on error result / unparseable payload', () => {
    const err = render(<StrategyBacktestCard {...owner(block('result', new Error('x')))}/>)
    expect(err.container.querySelector('[data-dshtrading-toolview]')).toBeNull()
    const bad = render(<StrategyBacktestCard {...owner(block('result', 'not json'))} />)
    expect(bad.container.querySelector('[data-dshtrading-toolview]')).toBeNull()
  })
})

describe('StrategyAuthorCard', () => {
  it('renders success summary', () => {
    const text = '[strategy_author] Successfully authored strategy "双均线" (id: dual-ma, horizon: swing, params: fast=20, slow=60). Done.'
    const { container } = render(<StrategyAuthorCard {...owner({ ...block('result', text), call: { name: 'strategy_author', argsRaw: '{}' } } as ToolCallOwnerProps['block'])} />)
    const card = container.querySelector('[data-dshtrading-toolview="strategy-author"]')
    expect(card?.getAttribute('data-ok')).toBe('true')
    expect(card?.textContent).toContain('双均线')
    expect(card?.textContent).toContain('fast=20, slow=60')
  })

  it('renders failure reason', () => {
    const text = '[strategy_author] Validation failed: signals must alternate'
    const { container } = render(<StrategyAuthorCard {...owner({ ...block('result', text), call: { name: 'strategy_author', argsRaw: '{}' } } as ToolCallOwnerProps['block'])} />)
    const card = container.querySelector('[data-dshtrading-toolview="strategy-author"]')
    expect(card?.getAttribute('data-ok')).toBe('false')
    expect(card?.textContent).toContain('signals must alternate')
  })

  it('returns null while running', () => {
    const { container } = render(<StrategyAuthorCard {...owner(block('running'))} />)
    expect(container.querySelector('[data-dshtrading-toolview]')).toBeNull()
  })
})