/**
 * 资产面板首开轮询（右侧 HoldingsPanel）：live 持仓刷新与批量盯市是两条独立轮询。
 *
 * 缺陷现场：两件事原本挤在同一个 effect、依赖 `[m2mTargetsKey]`，而该键由首拉写入的
 * 持仓派生——首拉成功即改键、effect 整段重跑，于是每次首开把 4 次 `/trade/positions`
 * 再打一遍（普查 A3）。
 *
 * 覆盖：
 *   - 首开只打一拍 live 刷新（四市场各 1 次 /trade/positions），整场 11 次请求；
 *   - 30s 第二拍照旧发生（拆开不能把常驻轮询一起弄没）；
 *   - 卸载即停（卸载后再过 60s 零新增请求）。
 *
 * 真实模块（组件 + store + api），无 mock、无 sleep：HTTP 传输层用真实 Response 桩，
 * 计时用假定时器推进。
 *
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { HoldingsPanel } from '../src/client/HoldingsPanel.tsx'

const t = (key: MarketLocaleKey): string => key

/** 真实规模的四市场 live 持仓条数（普查负载：crypto 2 / us 6 / cn 6 / hk 1 = 15）。 */
const POSITIONS: Readonly<Record<string, number>> = { crypto: 2, us: 6, cn: 6, hk: 1 }

const MARKETS_WIRE = ['crypto', 'us', 'cn', 'hk', 'global', 'futures']

interface Bridge { readonly requests: string[] }

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 真实 Response 桩：记录每次桥请求（路径 + 查询串），按端点回真实信封。 */
function stubBridge(): Bridge {
  const requests: string[] = []
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url.pathname + url.search)
    switch (url.pathname) {
      case '/dshtrading/api/markets':
        return jsonResponse({ markets: MARKETS_WIRE.map(id => ({ id, provider: id + '-provider' })) })
      case '/dshtrading/api/holdings':
        return jsonResponse({ ok: true, revision: 0, staged: [], holdings: [] })
      case '/dshtrading/api/fx':
        return jsonResponse({ ok: true, base: 'USD', rates: { USD: 1 }, asOf: 1, stale: false })
      case '/dshtrading/api/trade/positions': {
        const market = url.searchParams.get('market') ?? ''
        const count = POSITIONS[market] ?? 0
        return jsonResponse({
          ok: true,
          positions: Array.from({ length: count }, (_, i) => ({
            symbol: market.toUpperCase() + String(i), side: 'buy', size: 1, entryPrice: 100, markPrice: 100, timestamp: 1,
          })),
        })
      }
      case '/dshtrading/api/tickers': {
        const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
        const tickers: Record<string, unknown> = {}
        for (const symbol of symbols) {
          tickers[symbol] = { ok: true, ticker: { symbol, name: symbol, price: 100, prevClose: 99, changePercent: 1, timestamp: 1 } }
        }
        return jsonResponse({ tickers })
      }
      default:
        return new Response('not found', { status: 404 })
    }
  }) as unknown as typeof globalThis.fetch
  return { requests }
}

function countOf(net: Bridge, path: string): number {
  return net.requests.filter(request => request.startsWith(path)).length
}

/** 端点直方图（去掉查询串）：逐端点的请求次数。 */
function histogramOf(net: Bridge): Record<string, number> {
  const histogram: Record<string, number> = {}
  for (const request of net.requests) {
    const path = request.split('?')[0] ?? ''
    histogram[path] = (histogram[path] ?? 0) + 1
  }
  return histogram
}

/** 每次 /tickers 请求的市场（按调用顺序）。 */
function tickerMarkets(net: Bridge): string[] {
  return net.requests
    .filter(request => request.startsWith('/dshtrading/api/tickers'))
    .map(request => new URL(request, 'http://localhost').searchParams.get('market') ?? '')
}

/** 让首拍与依赖变化重跑的取数在假定时器下落地（每轮推进 1ms，远低于 30s 一拍）。 */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  }
}

/** 推进一拍常驻轮询（30s）。 */
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

describe('资产面板首开轮询（live 刷新与盯市解耦）', () => {
  it('用户首开资产面板时 live 持仓刷新只打一拍，30s 第二拍照旧发生且卸载即停', async () => {
    // Given 四市场共 15 条 live 持仓、台账无 imported 行
    const net = stubBridge()

    // When 打开面板，等首屏取数落地
    const view = render(<HoldingsPanel t={t} onClose={() => {}} />)
    await settle()

    // Then live 刷新只有一拍：四市场各 1 次（重复的第二拍会变成 8 次）
    expect(countOf(net, '/dshtrading/api/trade/positions')).toBe(4)
    // Then 整场 11 次请求：holdings/markets/fx 各 1 + positions 4 + tickers 4
    expect(histogramOf(net)).toEqual({
      '/dshtrading/api/holdings': 1,
      '/dshtrading/api/markets': 1,
      '/dshtrading/api/fx': 1,
      '/dshtrading/api/trade/positions': 4,
      '/dshtrading/api/tickers': 4,
    })
    expect(tickerMarkets(net).sort()).toEqual(['cn', 'crypto', 'hk', 'us'])

    // When 推进一拍 30s 常驻轮询
    await beat()

    // Then 第二拍照旧发生：live 再 4 次、盯市再 4 次
    expect(countOf(net, '/dshtrading/api/trade/positions')).toBe(8)
    expect(countOf(net, '/dshtrading/api/tickers')).toBe(8)

    // When 卸载面板后再过 60s
    view.unmount()
    const requestsAtUnmount = net.requests.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    await settle()

    // Then 卸载即停：零新增请求
    expect(net.requests).toHaveLength(requestsAtUnmount)
  })
})
