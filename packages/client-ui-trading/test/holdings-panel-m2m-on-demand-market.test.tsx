/**
 * 资产面板盯市：无常驻轮询预算市场的「按需取一次」（右侧 HoldingsPanel）。
 *
 * quote-budget.ts 的 NO_RESIDENT_POLL_MARKETS（global/金十）常驻预算为 0：盯市目标
 * 变化时按需取一次，之后不进常驻轮询，其余市场节奏不变。live 刷新与盯市拆成两条
 * 轮询时，这条判据（m2mOnDemandKeyRef）不能丢——本用例把它钉在请求计数上。
 *
 * 真实模块（组件 + store + api），无 mock、无 sleep：
 *   - live 侧一条美股持仓（有常驻预算）来自 /trade/positions 的真实应答；
 *   - 金十持仓（无常驻预算）经模拟账本的真实下单接口进入，盯市目标随即变化；
 *   - HTTP 传输层用真实 Response 桩，计时用假定时器推进。
 *
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { holdingsDataStore } from '../src/client/holdings-store.ts'
import { HoldingsPanel } from '../src/client/HoldingsPanel.tsx'
import { paperTradingStore } from '../src/client/paper-trading-store.ts'

const t = (key: MarketLocaleKey): string => key

const MARKETS_WIRE = ['crypto', 'us', 'cn', 'hk', 'global', 'futures']

interface Bridge { readonly requests: string[] }

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 真实 Response 桩：记录每次桥请求，按端点回真实信封（live 持仓只有 us 一条）。 */
function stubBridge(): Bridge {
  const requests: string[] = []
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url.pathname + url.search)
    const market = url.searchParams.get('market') ?? ''
    switch (url.pathname) {
      case '/dshtrading/api/markets':
        return jsonResponse({ markets: MARKETS_WIRE.map(id => ({ id, provider: id + '-provider' })) })
      case '/dshtrading/api/holdings':
        return jsonResponse({ ok: true, revision: 0, staged: [], holdings: [] })
      case '/dshtrading/api/fx':
        return jsonResponse({ ok: true, base: 'USD', rates: { USD: 1 }, asOf: 1, stale: false })
      case '/dshtrading/api/trade/positions':
        return jsonResponse({
          ok: true,
          positions: market === 'us'
            ? [{ symbol: 'AAPL', side: 'buy', size: 2, entryPrice: 100, markPrice: 100, timestamp: 1 }]
            : [],
        })
      case '/dshtrading/api/tickers': {
        const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
        const tickers: Record<string, unknown> = {}
        for (const symbol of symbols) {
          const price = symbol === 'XAUUSD' ? 2000 : 100
          tickers[symbol] = { ok: true, ticker: { symbol, name: symbol, price, prevClose: price, changePercent: 0, timestamp: 1 } }
        }
        return jsonResponse({ tickers })
      }
      default:
        return new Response('not found', { status: 404 })
    }
  }) as unknown as typeof globalThis.fetch
  return { requests }
}

/** 每次 /tickers 请求的市场（按调用顺序）。 */
function tickerMarkets(net: Bridge): string[] {
  return net.requests
    .filter(request => request.startsWith('/dshtrading/api/tickers'))
    .map(request => new URL(request, 'http://localhost').searchParams.get('market') ?? '')
}

function marketCalls(net: Bridge, market: string): number {
  return tickerMarkets(net).filter(seen => seen === market).length
}

/** 让首拍与依赖变化重跑的取数在假定时器下落地（每轮推进 1ms，远低于 30s 一拍）。 */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  }
}

async function beat(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  await settle()
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  globalThis.fetch = originalFetch
})

describe('资产面板盯市对无常驻轮询预算市场的按需语义', () => {
  it('用户持有金十标的时，盯市只在目标变化时取一次价，之后不进常驻轮询，有预算市场每拍照取', async () => {
    // Given 面板里已有一条美股 live 持仓（有常驻预算），金十持仓尚未进入盯市目标
    const net = stubBridge()
    const view = render(<HoldingsPanel t={t} onClose={() => {}} />)
    await settle()

    // Then 首拍按需只取有预算的市场，金十零请求（目标里还没有它）
    expect(tickerMarkets(net)).toEqual(['us'])
    expect(marketCalls(net, 'global')).toBe(0)

    // When 模拟账本新增一条金十品种（无常驻预算）→ 盯市目标变化
    act(() => {
      paperTradingStore.placeOrder({
        symbol: 'XAUUSD', side: 'buy', type: 'market', quantity: 1, currentPrice: 2000, market: 'global',
      })
    })
    await settle()

    // Then 目标变化这一拍按需放开全部目标：金十取一次价并落表
    expect(marketCalls(net, 'global')).toBe(1)
    expect(holdingsDataStore.getSnapshot().prices['global:XAUUSD']).toBe(2000)

    // When 推进第一拍 30s 常驻轮询
    await beat()

    // Then 目标没变 → 金十不再取价（不进常驻轮询），有预算市场照常每拍取一拍
    expect(marketCalls(net, 'global')).toBe(1)
    expect(marketCalls(net, 'us')).toBe(3)
    expect(holdingsDataStore.getSnapshot().prices['global:XAUUSD']).toBeUndefined()
    expect(holdingsDataStore.getSnapshot().prices['us:AAPL']).toBe(100)

    // When 再推一拍
    await beat()

    // Then 金十仍停在按需的那一次，有预算市场继续每拍照取
    expect(marketCalls(net, 'global')).toBe(1)
    expect(marketCalls(net, 'us')).toBe(4)

    view.unmount()
  })
})
