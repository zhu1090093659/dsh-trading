/**
 * 渲染作用域回归：1 Hz 状态栏时钟与无关的工具栏状态变化只应重渲染受影响节点，
 * 不得把整棵 QuoteStage 子树（最贵的子组件是 TvChart）拖进重渲染。
 *
 * 探针：TvChart 以 memo 包裹的计数桩替代（与真实导出一致），断言图表渲染次数增量。
 * memo 桩同时把「传给图表的 props 必须引用稳定」变成可回归的契约。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { SelectionState } from '../src/client/store.ts'
import type { ChartState } from '../src/client/chart-state.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const counters = vi.hoisted(() => ({ chart: 0 }))

vi.mock('../src/client/TvChart.tsx', async () => {
  const React = await import('react')
  return {
    TvChart: React.memo(function MockTvChart() { counters.chart += 1; return null }),
    toBar: (k: unknown) => k,
    toVolume: (k: unknown) => k,
  }
})

import { QuoteStage } from '../src/client/QuoteStage.tsx'

const t = (key: MarketLocaleKey): string => key

const KLINE = { openTime: 1, open: 1, high: 1.1, low: 0.9, close: 1, volume: 10, closeTime: 2 }
const KLINE2 = { openTime: 3, open: 1, high: 1.2, low: 1, close: 1.1, volume: 12, closeTime: 4 }

function props(symbol = 'HYPEUSDT') {
  const selection: SelectionState = { instrument: { market: 'crypto', symbol } }
  const chart: ChartState = { instances: [] }
  return {
    t,
    useSelection: <T,>(sel: (state: SelectionState) => T): T => sel(selection),
    useChart: <T,>(sel: (state: ChartState) => T): T => sel(chart),
    toggleIndicator: () => {},
    setIndicatorParams: () => {},
    setIndicatorVisible: () => {},
    removeIndicator: () => {},
    deleteIndicator: async () => true,
  }
}

beforeEach(() => {
  counters.chart = 0
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).includes('/klines?')) {
      return new Response(JSON.stringify({ klines: [KLINE, KLINE2] }), { status: 200 })
    }
    return new Response('{}', { status: 500 })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount() {
  const view = render(<QuoteStage {...props()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(counters.chart).toBeGreaterThanOrEqual(1)
  return view
}

describe('QuoteStage 渲染作用域', () => {
  it('状态栏秒级时钟推进 3 秒不重渲染图表', async () => {
    await mount()
    const before = counters.chart
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(counters.chart - before).toBe(0)
  })

  it('无关的工具栏状态变化（技术指标选择器开合）不重渲染图表', async () => {
    const view = await mount()
    const before = counters.chart
    fireEvent.click(view.getByText('indicator.picker'))
    expect(counters.chart - before).toBe(0)
  })

  it('图表真正消费的 props 变化仍然重渲染（memo 不吞更新）', async () => {
    const view = await mount()
    const before = counters.chart
    view.rerender(<QuoteStage {...props('BTCUSDT')} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(counters.chart - before).toBeGreaterThanOrEqual(1)
  })
})
