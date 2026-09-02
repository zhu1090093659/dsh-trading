/**
 * 盘口与逐笔单测（issue #39，mock fetch 不出网）：depth/trades 解析、
 * SWAP 输入归一、档位降/升序保持、契约升序流水。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BinanceMarketDataService } from '../src/index.js'

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
  '/api/v3/depth': {
    body: {
      lastUpdateId: 1,
      bids: [['42000.10', '1.2'], ['41999.50', '0.5'], ['0', '0']],
      asks: [['42000.30', '0.8'], ['42001.00', '2.0']],
    },
  },
  '/api/v3/trades': {
    body: [
      { id: 1, price: '41999.00', qty: '0.5', time: 1700000000000, isBuyerMaker: true },
      { id: 2, price: '42000.20', qty: '0.3', time: 1700000001000, isBuyerMaker: false },
    ],
  },
}

function service(fetchImpl: typeof fetch): BinanceMarketDataService {
  return new BinanceMarketDataService(makeServiceCtx(), { baseUrl: 'https://binance.test', fetchImpl }, 'test-key')
}

describe('BinanceMarketDataService.getOrderbook/getRecentTrades（issue #39）', () => {
  it('depth 20 档：过滤零档，bids 降序 / asks 升序（交易所原生序透传）', async () => {
    const { impl } = stubFetch(ROUTES)
    const orderbook = await service(impl).getOrderbook('BTCUSDT')
    expect(orderbook.symbol).toBe('BTCUSDT')
    expect(orderbook.bids).toEqual([{ price: 42000.1, amount: 1.2 }, { price: 41999.5, amount: 0.5 }])
    expect(orderbook.asks).toEqual([{ price: 42000.3, amount: 0.8 }, { price: 42001, amount: 2 }])
  })

  it('SWAP 输入归一到现货 depth 词汇（BTCUSDT-SWAP → BTCUSDT）', async () => {
    const { impl, urls } = stubFetch(ROUTES)
    await service(impl).getOrderbook('BTCUSDT-SWAP')
    expect(urls.find(url => url.includes('/api/v3/depth'))).toContain('symbol=BTCUSDT')
  })

  it('逐笔：isBuyerMaker → 主动方向，响应升序透传', async () => {
    const { impl } = stubFetch(ROUTES)
    const trades = await service(impl).getRecentTrades('BTCUSDT', 2)
    expect(trades.map(t => t.side)).toEqual(['sell', 'buy'])
    expect(trades[0]?.timestamp).toBeLessThan(trades[1]?.timestamp ?? 0)
  })
})
