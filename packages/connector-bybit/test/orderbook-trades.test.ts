/**
 * 盘口与逐笔单测（issue #39，mock fetch 不出网）：v5 orderbook/recent-trade 解析、
 * Bybit 响应新→旧 → 契约升序反转。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BybitMarketDataService } from '../src/index.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeServiceCtx(): Context {
  return {
    get: () => undefined,
    reflect: { provide: () => {} },
  } as unknown as Context
}

function stubFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes[new URL(url).pathname]
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body, route.status ?? 200)
  }) as typeof fetch
  return { impl, urls }
}

const ROUTES: Record<string, { status?: number; body?: unknown }> = {
  '/v5/market/orderbook': {
    body: {
      retCode: 0,
      result: {
        // v5 缩写字段：b=bids（降序）、a=asks（升序）——真实响应实证。
        b: [['42000.10', '1.2'], ['42000.00', '0.5']],
        a: [['42000.30', '0.8'], ['42000.50', '2.0']],
        ts: 1700000000000,
        s: 'BTCUSDT',
      },
    },
  },
  '/v5/market/recent-trade': {
    body: {
      retCode: 0,
      result: {
        list: [
          { execId: '2', price: '42000.20', size: '0.3', side: 'Buy', time: 1700000001000 },
          { execId: '1', price: '41999.00', size: '0.5', side: 'Sell', time: 1700000000000 },
        ],
      },
    },
  },
}

function service(fetchImpl: typeof fetch): BybitMarketDataService {
  return new BybitMarketDataService(makeServiceCtx(), { baseUrl: 'https://bybit.test', fetchImpl }, 'test-key')
}

describe('BybitMarketDataService.getOrderbook/getRecentTrades（issue #39）', () => {
  it('spot orderbook 25 档：档位行解析，bids 降序 / asks 升序保持', async () => {
    const { impl, urls } = stubFetch(ROUTES)
    const orderbook = await service(impl).getOrderbook('BTCUSDT')
    expect(orderbook.symbol).toBe('BTCUSDT')
    expect(orderbook.bids).toEqual([{ price: 42000.1, amount: 1.2 }, { price: 42000, amount: 0.5 }])
    expect(orderbook.asks[0]).toEqual({ price: 42000.3, amount: 0.8 })
    expect(orderbook.timestamp).toBe(1700000000000)
    const bookUrl = urls.find(url => url.includes('/v5/market/orderbook')) ?? ''
    expect(bookUrl).toContain('category=spot')
  })

  it('逐笔：Bybit 新→旧 → 契约升序；side 大写词汇归一', async () => {
    const { impl } = stubFetch(ROUTES)
    const trades = await service(impl).getRecentTrades('BTCUSDT', 2)
    expect(trades.map(t => t.id)).toEqual(['1', '2'])
    expect(trades.map(t => t.side)).toEqual(['sell', 'buy'])
  })
})
