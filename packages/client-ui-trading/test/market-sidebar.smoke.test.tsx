/**
 * MarketSidebar 迷你走势编排冒烟（2026-09-08 审查补充）：把侧栏真正 mount 进 jsdom，
 * 用 api 模块桩驱动「分钟线自适应粒度 → 日 K 降级」的取数编排，并断言固定交易时段
 * x 轴（xFractions）确实落到 Sparkline——纯函数单测（intraday-series.test.ts）覆盖
 * 不到这条接线，只测函数会漏掉「算对了但没传给图」的断层。
 *
 * 覆盖：
 * - 股票：先试 1m（桥 TRADING_UNSUPPORTED_INTERVAL）→ 降 5m，调用顺序可查；
 * - 5m 序列带 xFractions → 迷你走势只铺满已完成时段，不拉伸全宽；
 * - 1m + 5m 全失败 → 降级日 K（mode 'daily'，limit 32），序列照常渲染；
 * - crypto 取数归一为 5m×288（滚动 24h；API 层不出现 1m 请求）。
 *
 * @vitest-environment jsdom
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { SelectionState, Watchlists } from '../src/client/store.ts'
import { createWatchlistGroupsStore, createWatchlistStore } from '../src/client/store.ts'
import type { Kline, MarketId } from '../src/client/types.ts'

/**
 * 网络桩账本（vi.hoisted：mock 工厂先于 import 求值）。calls 按调用顺序记账，
 * 断言「先 1m 后 5m」这类编排只能靠它。
 */
const net = vi.hoisted(() => ({
  calls: [] as Array<{ market: string; symbol: string; interval: string; limit: number }>,
  /** symbol → 粒度 → 结果：unsupported = 桥 TRADING_UNSUPPORTED_INTERVAL；missing = 无数据/取数失败；ok = 返回 series[粒度]。 */
  plan: {} as Record<string, Record<string, 'unsupported' | 'missing' | 'ok'>>,
  /** 粒度 → K 线序列。 */
  series: {} as Record<string, Kline[]>,
  markets: [] as Array<{ id: 'crypto' | 'us' | 'cn' | 'hk' }>,
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchMarkets: async () => net.markets,
    // 断网桩：全集预取与在线联想一律空，序列完全由 net 决定。
    fetchSymbols: async () => [],
    fetchTickers: async () => ({}),
    fetchKlines: async (market: MarketId, symbol: string, interval: string, limit: number): Promise<Kline[]> => {
      net.calls.push({ market, symbol, interval, limit })
      const verdict = net.plan[symbol]?.[interval] ?? 'missing'
      if (verdict === 'unsupported') {
        // 桥的真实形态：HTTP 200 + 业务错误码，api.getJson 转 rejection。
        throw new actual.BridgeError(200, 'TRADING_UNSUPPORTED_INTERVAL: interval unsupported', 'TRADING_UNSUPPORTED_INTERVAL')
      }
      if (verdict === 'missing') throw new Error(`no klines: ${symbol} ${interval}`)
      return net.series[interval] ?? []
    },
  }
})

import { MarketSidebar } from '../src/client/MarketSidebar.tsx'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

/** 一根 K 线（迷你走势只用 openTime/close，其余字段补齐类型）。 */
function bar(openTime: number, close: number): Kline {
  return { openTime, open: close, high: close, low: close, close, volume: 0, closeTime: openTime + 60_000 }
}

// 2026-09-08（周二）美东常规时段 9:30–16:00 ET（EDT = UTC-4）内的四根 5m bar：
// 13:30Z=9:30 ET、14:30Z=10:30 ET、16:30Z=12:30 ET、18:00Z=14:00 ET。
const US_5M: Kline[] = [
  bar(Date.UTC(2026, 8, 8, 13, 30), 100),
  bar(Date.UTC(2026, 8, 8, 14, 30), 101),
  bar(Date.UTC(2026, 8, 8, 16, 30), 102),
  bar(Date.UTC(2026, 8, 8, 18, 0), 103),
]

/** 日 K 降级序列（三根，等距铺满）。 */
const DAILY: Kline[] = [
  bar(Date.UTC(2026, 8, 4, 13, 30), 300),
  bar(Date.UTC(2026, 8, 7, 13, 30), 310),
  bar(Date.UTC(2026, 8, 8, 13, 30), 320),
]

/** crypto 滚动 24h 的 5m 序列（两根，无 xFractions）。 */
const CRYPTO_5M: Kline[] = [
  bar(Date.UTC(2026, 8, 8, 1, 0), 200),
  bar(Date.UTC(2026, 8, 8, 1, 5), 201),
]

beforeEach(() => {
  // jsdom 默认 about:blank 原点下 localStorage 不可用 → store 的读写静默降级为会话内，
  // 不会跨例残留（readJson/writeJson 自带 try/catch）。
  net.calls = []
  net.plan = {}
  net.series = {}
  net.markets = []
})

afterEach(() => {
  cleanup()
})

function renderSidebar(rows: Array<{ market: MarketId; symbol: string; name?: string }>) {
  const watchlists = createWatchlistStore()
  for (const row of rows) watchlists.add(row.market, row)
  const groups = createWatchlistGroupsStore()
  const selection: SelectionState = { instrument: null }
  return render(
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
    />,
  )
}

/** 某标的行内迷你走势的折线坐标（x = 横向像素位置）。 */
function sparkPoints(getByText: (text: string) => HTMLElement, name: string): Array<[number, number]> {
  const row = getByText(name).closest('button')
  expect(row).toBeTruthy()
  const polyline = row?.querySelector('polyline')
  expect(polyline).toBeTruthy()
  return (polyline?.getAttribute('points') ?? '').trim().split(/\s+/).map((pair) => {
    const [x, y] = pair.split(',')
    return [Number(x), Number(y)] as [number, number]
  })
}

/** 某标的的 K 线请求序列（interval:limit，按调用顺序）。 */
function callsOf(symbol: string): string[] {
  return net.calls.filter(call => call.symbol === symbol).map(call => `${call.interval}:${call.limit}`)
}

describe('MarketSidebar 迷你走势编排冒烟', () => {
  it('1m 不支持 → 降级 5m，且 xFractions 让走势只铺满已完成时段', async () => {
    net.markets = [{ id: 'us' }]
    net.series = { '5m': US_5M, '1d': DAILY }
    net.plan = { AAPL: { '1m': 'unsupported', '5m': 'ok', '1d': 'ok' } }
    const view = renderSidebar([{ market: 'us', symbol: 'AAPL', name: '苹果' }])

    // 取数编排：先 1m（被桥拒）→ 再 5m（成功）→ 末尾补拉 prevClose 的 1d×2
    await waitFor(() => { expect(callsOf('AAPL')).toEqual(['1m:500', '5m:200', '1d:2']) })
    // 5m 成功后不再走日 K 降级（limit 32 缺席）
    expect(net.calls.filter(call => call.interval === '1d' && call.limit === 32)).toHaveLength(0)

    const points = sparkPoints(view.getByText, '苹果')
    expect(points).toHaveLength(US_5M.length)
    const xs = points.map(([x]) => x)
    expect(xs[0]).toBeCloseTo(0, 5)                 // 9:30 ET 开盘 → 左边缘
    // 14:00 ET = 270/390 时段位置；无 xFractions 时序列等距铺满，末点恰为 56
    expect(xs[3]).toBeCloseTo((270 / 390) * 56, 1)
    expect(xs[3]).toBeLessThan(56 * 0.99)
  })

  it('1m 与 5m 均失败 → 降级日 K（mode daily，limit 32），走势照常渲染', async () => {
    net.markets = [{ id: 'us' }]
    net.series = { '1d': DAILY }
    net.plan = { MSFT: { '1m': 'unsupported', '5m': 'unsupported', '1d': 'ok' } }
    const view = renderSidebar([{ market: 'us', symbol: 'MSFT', name: '微软' }])

    // 两档分钟线都试过才降日 K；日 K 之后仍会补拉 prevClose 的 1d×2
    await waitFor(() => { expect(callsOf('MSFT')).toEqual(['1m:500', '5m:200', '1d:32', '1d:2']) })

    // 日 K 序列三根 → 等距铺满（日 K 无 xFractions）
    const points = sparkPoints(view.getByText, '微软')
    expect(points).toHaveLength(DAILY.length)
    expect(points.map(([x]) => x)).toEqual([0, 28, 56])
  })

  it('crypto 取数归一为 5m×288（滚动 24h，不出现 1m 请求），走势等距铺满', async () => {
    net.markets = [{ id: 'crypto' }]
    net.series = { '5m': CRYPTO_5M, '1d': DAILY }
    net.plan = { BTCUSDT: { '5m': 'ok', '1d': 'ok' } }
    const view = renderSidebar([{ market: 'crypto', symbol: 'BTCUSDT', name: '比特币' }])

    // crypto 候选只有 5m，且 intradayRequest 把 crypto 的任意候选归一为 5m×288：
    // API 层既不出现 1m 请求，也不按股票口径 200 根取数。
    await waitFor(() => { expect(callsOf('BTCUSDT')).toEqual(['5m:288', '1d:2']) })
    expect(net.calls.some(call => call.interval === '1m')).toBe(false)

    const points = sparkPoints(view.getByText, '比特币')
    expect(points).toHaveLength(CRYPTO_5M.length)
    expect(points.map(([x]) => x)).toEqual([0, 56])
  })
})
