/**
 * 盘口与逐笔单测（issue #39，mock fetch 不出网）：books/trades 解析、
 * OKX 响应新→旧 → 契约升序反转。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { OkxRestClient } from '../src/rest.js'
import { OkxMarketDataService } from '../src/index.js'

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeServiceCtx(): Context {
  return {
    get: () => undefined,
    reflect: { provide: () => {} },
  } as unknown as Context
}

function routeByPath(routes: Record<string, { status?: number; body?: unknown }>) {
  const impl = (async (input: unknown) => {
    const url = String(input)
    const route = routes[new URL(url).pathname]
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return okResponse(route.body, route.status ?? 200)
  }) as typeof fetch
  return impl
}

const ROUTES: Record<string, { status?: number; body?: unknown }> = {
  '/api/v5/market/books': {
    body: {
      code: '0',
      data: [{
        instId: 'BTC-USDT',
        bids: [['42000.1', '1.2', '0', '2'], ['42000.0', '0.5', '0', '1']],
        asks: [['42000.3', '0.8', '0', '1'], ['42000.5', '2.0', '0', '3']],
        ts: '1700000000000',
      }],
    },
  },
  '/api/v5/market/trades': {
    body: {
      code: '0',
      data: [
        { instId: 'BTC-USDT', tradeId: '2', px: '42000.2', sz: '0.3', side: 'buy', ts: '1700000001000' },
        { instId: 'BTC-USDT', tradeId: '1', px: '41999.0', sz: '0.5', side: 'sell', ts: '1700000000000' },
      ],
    },
  },
}

function service(fetchImpl: typeof fetch): OkxMarketDataService {
  const rest = new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, clockSync: false, clockOffsetMs: 0 })
  return new OkxMarketDataService(makeServiceCtx(), {}, rest, 'test-key')
}

describe('OkxMarketDataService.getOrderbook/getRecentTrades（issue #39）', () => {
  it('books 20 档：档位行 [price, size, …] 解析，输出规范形 symbol', async () => {
    const data = await service(routeByPath(ROUTES)).getOrderbook('BTC-USDT')
    expect(data.symbol).toBe('BTCUSDT')
    expect(data.bids).toEqual([{ price: 42000.1, amount: 1.2 }, { price: 42000, amount: 0.5 }])
    expect(data.asks[0]).toEqual({ price: 42000.3, amount: 0.8 })
    expect(data.timestamp).toBe(1700000000000)
  })

  it('逐笔：OKX 新→旧 → 契约升序（旧→新）', async () => {
    const trades = await service(routeByPath(ROUTES)).getRecentTrades('BTC-USDT', 2)
    expect(trades.map(t => t.id)).toEqual(['1', '2'])
    expect(trades.map(t => t.side)).toEqual(['sell', 'buy'])
  })
})
