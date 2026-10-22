/**
 * 交易台只读轮询的守卫（issue #40 面）：一次 refreshTradeDesk 打 4 个签名端点
 * （/trade/positions、/trade/balances、/trade/orders、/trade/fills），唯一的渲染消费方是
 * 交易台面板（OrderPanel，以及面板比例填单用的 currentPositionSize/availableCash）。
 * 面板关着时这 4 个响应零消费者——守卫跟着面板开关收紧到「开面板才拉」；
 * 实盘例外（风险可见性优先于省请求）。打开面板那一刻必须立刻取一次
 * （usePoll 依赖变化即 tick），不让用户先看到空面板再等 15s。
 *
 * 计数单位：全局 fetch 桩按 URL 记录调用次数，走真实 QuoteStage + 真实 api.ts 路径。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { presetDefinitions } from '@dshtrading/indicators'
import type { ChartState } from '../src/client/chart-state.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { SelectionState } from '../src/client/store.ts'
import { indicators } from '../src/client/indicator-registry.ts'
import { writeTradeMode } from '../src/client/trade-mode-store.ts'
import { QuoteStage } from '../src/client/QuoteStage.tsx'

const t = (key: MarketLocaleKey): string => key

/** 一次 refreshTradeDesk 打的四个签名端点（顺序与 Promise.all 一致）。 */
const TRADE_ENDPOINTS = ['/trade/positions', '/trade/balances', '/trade/orders', '/trade/fills'] as const

const realFetch = globalThis.fetch
let urls: string[] = []

const tradeRequests = (): string[] => urls.filter(url => url.includes('/trade/'))
const countOf = (endpoint: string): number => tradeRequests().filter(url => url.includes(endpoint)).length

const props = {
  t,
  useSelection: <T,>(sel: (state: SelectionState) => T): T => sel({ instrument: { market: 'crypto' as const, symbol: 'HYPEUSDT' } }),
  useChart: <T,>(sel: (state: ChartState) => T): T => sel({ instances: [] }),
  toggleIndicator: () => {},
  setIndicatorParams: () => {},
  setIndicatorVisible: () => {},
  setIndicatorScope: () => {},
  removeIndicator: () => {},
  deleteIndicator: async () => true,
}

beforeEach(() => {
  for (const definition of presetDefinitions()) indicators.register(definition)
  urls = []
  vi.useFakeTimers()
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    // K 线一律空表：jsdom 没有 canvas，图上有数据就没法在这个用例里走真实渲染路径。
    if (url.includes('/klines?')) return new Response(JSON.stringify({ klines: [] }), { status: 200 })
    if (url.includes('/trade/positions')) return new Response(JSON.stringify({ ok: true, positions: [] }), { status: 200 })
    if (url.includes('/trade/balances')) return new Response(JSON.stringify({ ok: true, balances: [] }), { status: 200 })
    if (url.includes('/trade/orders')) return new Response(JSON.stringify({ ok: true, orders: [] }), { status: 200 })
    if (url.includes('/trade/fills')) return new Response(JSON.stringify({ ok: true, fills: [] }), { status: 200 })
    if (url.includes('/news?')) return new Response(JSON.stringify({ ok: true, items: [], unavailable: [] }), { status: 200 })
    return new Response(JSON.stringify({ tickers: {}, markets: [], symbols: [], derivatives: null }), { status: 200 })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  vi.useRealTimers()
  // 交易模式是模块级 store：每个用例复位，避免 case 之间串味。开关记忆确实落盘
  // （本文件写 dshtrading:trade:mode，QuoteStage.tsx:2039 写 dshtrading.tradeDesk.open），
  // 跨用例的存储泄漏由 test/setup.ts 的 beforeEach 清空兜底。
  writeTradeMode('paper')
})

/** 挂载行情中栏并让挂载那一拍取数落地（不推进 15s 定时器）。 */
async function mountQuoteStage() {
  const view = render(<QuoteStage {...props} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  return view
}

describe('交易台只读轮询：面板开关就是守卫', () => {
  it('用户在模拟盘、交易台关闭时打开中栏：四个签名端点一拍都不发', async () => {
    // Given 交易台默认关闭（开关记忆读不到即关）、交易模式默认模拟盘
    // When 用户挂载行情中栏并等挂载那一拍取数落地
    const view = await mountQuoteStage()

    // Then 开关按钮报告未按下，四个签名端点各 0 次——面板关着时这些响应没有消费者，不做预热
    expect(view.getByText('trade.toggle').getAttribute('aria-pressed')).toBe('false')
    for (const endpoint of TRADE_ENDPOINTS) expect(countOf(endpoint)).toBe(0)
  })

  it('用户点开交易台：四个签名端点立刻各取一次，不等 15s 定时器', async () => {
    // Given 中栏已挂载完成、交易台关闭、挂载那一拍已落地
    const view = await mountQuoteStage()
    urls = []

    // When 用户点开交易台开关，且时间一点也不往前推
    fireEvent.click(view.getByText('trade.toggle'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    // Then 四个端点各恰好 1 次：打开即取，面板不空等一拍
    for (const endpoint of TRADE_ENDPOINTS) expect(countOf(endpoint)).toBe(1)
  })

  it('用户页签 chart→news→chart 且交易台关闭：回程不再打交易台', async () => {
    // Given 中栏已挂载完成、交易台关闭
    const view = await mountQuoteStage()
    urls = []

    // When 用户切到新闻页签，再切回图表页签
    fireEvent.click(view.getByText('quote.tab.news'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    fireEvent.click(view.getByText('quote.tab.chart'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    // Then 回程 0 次——页签仍在 deps 里，但面板关闭这一支被守卫挡掉
    expect(tradeRequests()).toEqual([])
  })

  it('用户把交易模式切到实盘、交易台关闭：挂载即轮询', async () => {
    // Given 交易模式为实盘（风险可见性优先于省请求）、交易台关闭
    writeTradeMode('live')

    // When 用户挂载行情中栏并等挂载那一拍落地
    await mountQuoteStage()

    // Then 四个签名端点各 1 次
    for (const endpoint of TRADE_ENDPOINTS) expect(countOf(endpoint)).toBe(1)
  })

  it('用户关掉交易台：下一拍 15s 不再打交易台', async () => {
    // Given 交易台打开、打开那一拍已落地
    const view = await mountQuoteStage()
    fireEvent.click(view.getByText('trade.toggle'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(countOf('/trade/positions')).toBe(1)
    urls = []

    // When 用户关掉面板并让 15s 定时器走一拍
    fireEvent.click(view.getByText('trade.toggle'))
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })

    // Then 交易台 0 次（关闭那一刻的重跑也被守卫挡掉）
    expect(tradeRequests()).toEqual([])
  })
})
