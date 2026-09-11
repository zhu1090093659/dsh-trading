/**
 * MarketSidebar 静止行情静默与走势渲染作用域（桌面端左侧自选面板）：
 *
 * 1. 面板常驻，8s 行情轮询必须在「展示字段真的变化」时才 setState、才重建动态
 *    字典；否则休市/静止行情下整表全天候空转（每拍 N 行重渲染 + 一次全表字典重建）。
 * 2. Sparkline 已 memo：价格数字变了但走势序列/方向/色彩模式没变时不重算 path。
 * 3. 选中态变化要把选中行滚入视野（搜索添加/宿主同步的选中行原本可能在视野外）。
 *
 * 探针与真实导出一致：Sparkline 用 memo 计数桩，动态字典用 updateDynamicCatalog 计数。
 *
 * @vitest-environment jsdom
 */
import { memo } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Instrument, Kline, MarketId, Ticker } from '../src/client/types.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { SelectionState, Watchlists } from '../src/client/store.ts'
import { createWatchlistGroupsStore, createWatchlistStore } from '../src/client/store.ts'

const net = vi.hoisted(() => ({
  mode: 'static' as 'static' | 'changing' | 'flip',
  tickerCalls: 0,
  sparkRenders: 0,
  dynUpdates: 0,
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  const bar = (openTime: number, close: number): Kline => ({ openTime, open: close, high: close, low: close, close, volume: 0, closeTime: openTime + 60_000 })
  const series: Kline[] = Array.from({ length: 390 }, (_, i) => bar(Date.UTC(2026, 8, 8, 13, 30) + i * 60_000, 100 + (i % 5)))
  return {
    ...actual,
    fetchMarkets: async () => [{ id: 'us' as MarketId }],
    fetchSymbols: async () => [],
    fetchKlines: async (): Promise<Kline[]> => series,
    fetchTickers: async (_market: MarketId, symbols: string[]): Promise<Record<string, { ok: true; ticker: Ticker }>> => {
      net.tickerCalls += 1
      const price = net.mode === 'static' ? 100 : net.mode === 'changing' ? 100 + net.tickerCalls : (net.tickerCalls % 2 === 0 ? 98 : 101)
      const out: Record<string, { ok: true; ticker: Ticker }> = {}
      for (const symbol of symbols) {
        out[symbol] = { ok: true, ticker: { symbol, name: 'Name ' + symbol, price, prevClose: 99, changePercent: 1.01, timestamp: net.tickerCalls } }
      }
      return out
    },
  }
})

vi.mock('../src/client/symbol-catalog.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/symbol-catalog.ts')>()
  return { ...actual, setDynamicCatalog: () => {}, updateDynamicCatalog: () => { net.dynUpdates += 1 } }
})

// 与真实导出一致：Sparkline 是 memo 组件。
vi.mock('../src/client/Sparkline.tsx', () => ({
  Sparkline: memo(function MockSparkline(props: { values: readonly number[] }) {
    net.sparkRenders += 1
    return <svg data-points={props.values.length} />
  }),
}))

import { MarketSidebar } from '../src/client/MarketSidebar.tsx'
import { displayTickerEqual } from '../src/client/MarketSidebar.tsx'

const t = (key: MarketLocaleKey): string => key

interface Harness {
  view: ReturnType<typeof render>
  selection: SelectionState
  rerender: () => void
}

function renderSidebar(rows: Array<{ market: MarketId; symbol: string; name?: string }>): Harness {
  const watchlists = createWatchlistStore()
  for (const row of rows) watchlists.add(row.market, row)
  const groups = createWatchlistGroupsStore()
  const selection: SelectionState = { instrument: null }
  const element = (): React.JSX.Element => (
    <MarketSidebar
      t={t}
      useSelection={<T,>(sel: (value: SelectionState) => T): T => sel(selection)}
      useWatchlists={<T,>(sel: (value: Watchlists) => T): T => sel(watchlists.getSnapshot())}
      useGroups={<T,>(sel: (value: ReturnType<typeof groups.getSnapshot>) => T): T => sel(groups.getSnapshot())}
      addInstrument={() => {}}
      removeInstrument={() => {}}
      selectInstrument={() => {}}
      openSettings={() => {}}
      createGroup={async () => ({ ok: false as const, reason: 'unavailable' as const })}
      renameGroup={async () => ({ ok: false as const, reason: 'unavailable' as const })}
      deleteGroup={async () => false}
      assignGroupMember={async () => true}
      setActiveGroup={() => {}}
    />
  )
  const view = render(element())
  return { view, selection, rerender: () => { view.rerender(element()) } }
}

async function settle(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
}

/** 推进一个 8s 行情轮询并返回本轮走势重算次数。 */
async function poll(): Promise<number> {
  net.sparkRenders = 0
  await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
  return net.sparkRenders
}

let originalScrollIntoView: unknown

beforeEach(() => {
  net.mode = 'static'
  net.tickerCalls = 0
  net.sparkRenders = 0
  net.dynUpdates = 0
  originalScrollIntoView = (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (originalScrollIntoView === undefined) delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
  else (Element.prototype as unknown as Record<string, unknown>).scrollIntoView = originalScrollIntoView
})

describe('MarketSidebar 静止行情静默', () => {
  it('休市/价格不变时，8s 轮询不重渲染走势、不重建动态字典', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ market: 'us' as MarketId, symbol: 'S' + i, name: 'Stock ' + i }))
    renderSidebar(rows)
    await settle()
    const dynAfterMount = net.dynUpdates
    expect(dynAfterMount).toBeGreaterThanOrEqual(1) // 挂载首拍回灌一次真实名称

    const renders = [await poll(), await poll(), await poll(), await poll(), await poll()]
    expect(renders).toEqual([0, 0, 0, 0, 0])
    expect(net.dynUpdates - dynAfterMount).toBe(0) // 名称未变 → 不再重建字典
  })

  it('价格真的变化时仍更新行内报价', async () => {
    net.mode = 'changing'
    const rows = [{ market: 'us' as MarketId, symbol: 'AAPL', name: '苹果' }]
    const { view } = renderSidebar(rows)
    await settle()
    const row = view.getByText('AAPL').closest('button') as HTMLElement
    const before = row.textContent
    await poll()
    expect(row.textContent).not.toBe(before)
  })

  it('涨跌方向不变时走势 memo 短路（价格数字变化不重算 path）', async () => {
    net.mode = 'changing'
    const rows = [{ market: 'us' as MarketId, symbol: 'AAPL', name: '苹果' }]
    renderSidebar(rows)
    await settle()
    net.sparkRenders = 0
    expect(await poll()).toBe(0)
  })

  it('涨跌方向翻转时走势仍重渲染（memo 不吞更新）', async () => {
    net.mode = 'flip'
    const rows = [{ market: 'us' as MarketId, symbol: 'AAPL', name: '苹果' }]
    renderSidebar(rows)
    await settle()
    net.sparkRenders = 0
    const renders = [await poll(), await poll()]
    expect(renders.every(count => count >= 1)).toBe(true)
  })
})

describe('displayTickerEqual（展示字段等价判定）', () => {
  const base: Ticker = { symbol: 'AAPL', name: '苹果', price: 100, prevClose: 99, changePercent: 1.01, timestamp: 1 }

  it('仅 timestamp 变化视为等价（不触发重渲染）', () => {
    expect(displayTickerEqual(base, { ...base, timestamp: 2 })).toBe(true)
  })

  it('价格/昨收/名称变化视为不等价', () => {
    expect(displayTickerEqual(base, { ...base, price: 101 })).toBe(false)
    expect(displayTickerEqual(base, { ...base, prevClose: 98 })).toBe(false)
    expect(displayTickerEqual(base, { ...base, name: '苹果公司' })).toBe(false)
  })

  it('首见标的（无旧值）视为变化', () => {
    expect(displayTickerEqual(undefined, base)).toBe(false)
  })
})

describe('MarketSidebar 选中行滚动可见', () => {
  it('选中态变化时把选中行滚入视野', async () => {
    const scrollSpy = vi.fn()
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = scrollSpy
    const rows = [{ market: 'us' as MarketId, symbol: 'AAPL', name: '苹果' }, { market: 'us' as MarketId, symbol: 'MSFT', name: '微软' }]
    const { selection, rerender } = renderSidebar(rows)
    await settle()
    scrollSpy.mockClear()
    selection.instrument = rows[1] as Instrument
    rerender()
    await act(async () => {})
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
  })
})
