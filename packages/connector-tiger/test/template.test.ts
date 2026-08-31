import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  TigerRestClient,
  toTigerSymbol,
} from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body, route.status)
  }) as typeof fetch
  return { impl, urls }
}

describe('TigerRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(toTigerSymbol('00700')).toEqual({ symbol: '00700', canonical: '00700.HK', secType: 'STK' })
    expect(toTigerSymbol('00700.HK')).toEqual({ symbol: '00700', canonical: '00700.HK', secType: 'STK' })
    expect(toTigerSymbol('AAPL')).toEqual({ symbol: 'AAPL', canonical: 'AAPL', secType: 'STK' })
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('TigerRestClient.getTicker', () => {
  it('拉取快照', async () => {
    const { impl } = stubFetch([
      {
        match: 'openapi.itiger.com',
        body: {
          code: 0,
          data: [
            {
              symbol: '00700',
              latestPrice: 380.2,
              volume: 15000000,
              timestamp: 1725000000000,
            },
          ],
        },
      },
    ])
    const client = new TigerRestClient({ fetchImpl: impl, tigerId: 'test-id' })
    const ticker = await client.getTicker('00700.HK')

    expect(ticker.symbol).toBe('00700.HK')
    expect(ticker.price).toBe(380.2)
  })
})
