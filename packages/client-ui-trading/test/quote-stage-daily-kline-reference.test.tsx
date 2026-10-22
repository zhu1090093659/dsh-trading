/**
 * 头部昨收/涨跌的「日 K 参考序列」取数：默认 1d 周期下 K 线轮询与日 K 参考打的是同一个
 * 桥 URL（market + symbol + interval=1d + limit=750），后者只喂头部昨收与涨跌两个数。
 * 桥的 K 线候选序对同参数是确定的（active 在首、其余按 provider 名升序，且只有
 * TRADING_UNSUPPORTED_INTERVAL 才换源），所以参考序列直接吃 K 线那一拍的尾部两根：
 * 少发一条 750 根请求，且头部与图表序列同源。非日线周期仍另取一次 1d 参考。
 *
 * 计数单位：全局 fetch 桩按 URL 记录调用次数，走真实 QuoteStage + 真实 api.ts 路径。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { presetDefinitions } from '@dshtrading/indicators'
import type { Kline } from '../src/client/types.ts'
import type { ChartState } from '../src/client/chart-state.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { SelectionState } from '../src/client/store.ts'
import { indicators } from '../src/client/indicator-registry.ts'
import { QuoteStage } from '../src/client/QuoteStage.tsx'

const t = (key: MarketLocaleKey): string => key

const realFetch = globalThis.fetch
let urls: string[] = []
/** 第 n 次（1-based）1d 请求返回的序列；缺省空表（jsdom 无 canvas，图上不要有数据）。 */
let oneDaySeries: (call: number) => readonly Kline[] = () => []
let oneDayCalls = 0

const oneDayRequests = (): string[] => urls.filter(url => url.includes('interval=1d&limit=750'))

const bar = (openTime: number, close: number): Kline => ({ openTime, open: close, high: close, low: close, close, volume: 1, closeTime: openTime + 86_400_000 })

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
  oneDayCalls = 0
  oneDaySeries = () => []
  vi.useFakeTimers()
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/klines?')) {
      if (!url.includes('interval=1d')) return new Response(JSON.stringify({ klines: [] }), { status: 200 })
      oneDayCalls += 1
      return new Response(JSON.stringify({ klines: oneDaySeries(oneDayCalls) }), { status: 200 })
    }
    if (url.includes('/news?')) return new Response(JSON.stringify({ ok: true, items: [], unavailable: [] }), { status: 200 })
    return new Response(JSON.stringify({ tickers: {}, markets: [], symbols: [], derivatives: null }), { status: 200 })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

async function mountQuoteStage() {
  const view = render(<QuoteStage {...props} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  return view
}

describe('日 K 参考序列：1d 下不再另发一条同样的请求', () => {
  it('用户在默认日线周期挂载：750 根的 1d 请求只发一次', async () => {
    // Given 默认周期 1d、标的 crypto:HYPEUSDT
    // When 用户挂载行情中栏并等挂载那一拍取数落地
    await mountQuoteStage()

    // Then 1d/750 的请求恰好 1 次（原先是 K 线轮询 + 日 K 参考各一次）
    expect(oneDayRequests()).toHaveLength(1)
  })

  it('用户停在日线周期：头部昨收取自图表序列的倒数第二根', async () => {
    // Given 桥对第一次 1d 请求（图表序列）回 99/110，对第二次（旧日 K 参考）回 100/120——两个来源可区分
    oneDaySeries = (call) => (call === 1 ? [bar(1, 99), bar(2, 110)] : [bar(1, 100), bar(2, 120)])

    // When 用户挂载行情中栏并立刻切走图表页签（jsdom 无 canvas：数据不喂进图表），再等取数落地
    const view = render(<QuoteStage {...props} />)
    fireEvent.click(view.getByText('quote.tab.news'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    // Then 头部涨跌 = 110 对 99 → +11.00 / +11.11%（不是另一条请求那份的 +10.00）
    expect(view.container.textContent).toContain('+11.00')
    expect(view.container.textContent).toContain('+11.11%')
  })

  it('用户切到分钟周期：仍取一次 1d 参考序列（头部不空着）', async () => {
    // Given 中栏已按默认 1d 挂载完成
    const view = await mountQuoteStage()
    urls = []

    // When 用户点 5m 周期（分钟视图的头部仍要昨收/涨跌）
    fireEvent.click(view.getByText('interval.5m'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    // Then 该次切换补一次 1d/750 的参考请求
    expect(oneDayRequests()).toHaveLength(1)
  })
})
