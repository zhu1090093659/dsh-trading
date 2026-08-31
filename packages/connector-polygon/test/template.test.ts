import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  normalizeUsSymbol,
  PolygonRestClient,
  toPolygonTimespan,
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

describe('PolygonRestClient 符号与周期映射', () => {
  it('代码归一化', () => {
    expect(normalizeUsSymbol('aapl')).toBe('AAPL')
    expect(normalizeUsSymbol(' TSLA ')).toBe('TSLA')
  })

  it('支持的 interval 词汇与 Polygon timespan 映射', () => {
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(toPolygonTimespan('1m')).toEqual({ multiplier: 1, timespan: 'minute' })
    expect(toPolygonTimespan('5m')).toEqual({ multiplier: 5, timespan: 'minute' })
    expect(toPolygonTimespan('1h')).toEqual({ multiplier: 1, timespan: 'hour' })
    expect(toPolygonTimespan('1d')).toEqual({ multiplier: 1, timespan: 'day' })
  })
})

describe('PolygonRestClient.getTicker', () => {
  it('拉取前日/最新快照', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v2/aggs/ticker/AAPL/prev',
        body: {
          ticker: 'AAPL',
          resultsCount: 1,
          results: [
            {
              T: 'AAPL',
              c: 220.5,
              h: 221.0,
              l: 219.5,
              o: 220.0,
              v: 50000000,
              t: 1725000000000,
            },
          ],
        },
      },
    ])
    const client = new PolygonRestClient({ fetchImpl: impl, apiKey: 'test-key' })
    const ticker = await client.getTicker('AAPL')

    expect(urls[0]).toContain('/v2/aggs/ticker/AAPL/prev')
    expect(urls[0]).toContain('apiKey=test-key')
    expect(ticker).toEqual({
      symbol: 'AAPL',
      price: 220.5,
      volume: 50000000,
      timestamp: 1725000000000,
    })
  })
})

describe('PolygonRestClient.getKlines', () => {
  it('拉取 5m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v2/aggs/ticker/AAPL/range/5/minute',
        body: {
          results: [
            {
              c: 220.5,
              h: 221.0,
              l: 219.5,
              o: 220.0,
              v: 250000,
              t: 1725000000000,
            },
          ],
        },
      },
    ])
    const client = new PolygonRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('AAPL', '5m', 10)

    expect(urls[0]).toContain('/range/5/minute')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 220.0,
      close: 220.5,
      high: 221.0,
      low: 219.5,
      volume: 250000,
    })
  })
})
