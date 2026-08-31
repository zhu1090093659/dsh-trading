import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  LongbridgeRestClient,
  toLongbridgePeriod,
  toLongbridgeSymbol,
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

describe('LongbridgeRestClient 符号与周期映射', () => {
  it('港股代码转长桥代码与规范形', () => {
    expect(toLongbridgeSymbol('700')).toEqual({ symbol: '00700.HK', canonical: '00700.HK' })
    expect(toLongbridgeSymbol('00700.HK')).toEqual({ symbol: '00700.HK', canonical: '00700.HK' })
    expect(toLongbridgeSymbol('9988')).toEqual({ symbol: '09988.HK', canonical: '09988.HK' })
  })

  it('支持的 interval 词汇与 Longbridge period 映射', () => {
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(toLongbridgePeriod('5m')).toBe('5m')
    expect(toLongbridgePeriod('1h')).toBe('60m')
    expect(toLongbridgePeriod('1d')).toBe('day')
    expect(toLongbridgePeriod('1w')).toBe('week')
  })
})

describe('LongbridgeRestClient.getTicker', () => {
  it('拉取并解析港股实时行情', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v1/quote/realtime',
        body: {
          code: 0,
          data: [
            {
              symbol: '00700.HK',
              last_done: '385.4',
              volume: '1500000',
              timestamp: 1725000000,
            },
          ],
        },
      },
    ])
    const client = new LongbridgeRestClient({ fetchImpl: impl, accessToken: 'token-xyz' })
    const ticker = await client.getTicker('00700.HK')

    expect(urls[0]).toContain('symbol=00700.HK')
    expect(ticker).toEqual({
      symbol: '00700.HK',
      price: 385.4,
      volume: 1500000,
      timestamp: 1725000000000,
    })
  })
})

describe('LongbridgeRestClient.getKlines', () => {
  it('拉取 5m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v1/quote/candlesticks',
        body: {
          code: 0,
          data: {
            candlesticks: [
              {
                open: '384.0',
                close: '385.4',
                high: '386.0',
                low: '383.8',
                volume: '50000',
                timestamp: 1725000000,
              },
            ],
          },
        },
      },
    ])
    const client = new LongbridgeRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('00700.HK', '5m', 10)

    expect(urls[0]).toContain('period=5m')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 384.0,
      close: 385.4,
      high: 386.0,
      low: 383.8,
      volume: 50000,
    })
  })
})
