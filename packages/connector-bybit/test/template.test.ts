import { describe, expect, it } from 'vitest'
import {
  BybitRestClient,
  INTERVAL_VOCABULARY,
  normalizeCryptoSymbol,
  toBybitInterval,
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

describe('BybitRestClient 符号与周期映射', () => {
  it('加密代码归一化', () => {
    expect(normalizeCryptoSymbol('btc-usdt')).toBe('BTCUSDT')
    expect(normalizeCryptoSymbol('ETH/USDT')).toBe('ETHUSDT')
  })

  it('支持的 interval 词汇与 Bybit interval 映射', () => {
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(toBybitInterval('1m')).toBe('1')
    expect(toBybitInterval('5m')).toBe('5')
    expect(toBybitInterval('1h')).toBe('60')
    expect(toBybitInterval('4h')).toBe('240')
    expect(toBybitInterval('1d')).toBe('D')
  })
})

describe('BybitRestClient.getTicker', () => {
  it('拉取并解析 Bybit 现货 Ticker', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v5/market/tickers',
        body: {
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [
              {
                symbol: 'BTCUSDT',
                lastPrice: '62500.5',
                volume24h: '15000.5',
                time: 1725000000000,
              },
            ],
          },
        },
      },
    ])
    const client = new BybitRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('BTCUSDT')

    expect(urls[0]).toContain('symbol=BTCUSDT')
    expect(ticker).toEqual({
      symbol: 'BTCUSDT',
      price: 62500.5,
      volume: 15000.5,
      timestamp: 1725000000000,
    })
  })
})

describe('BybitRestClient.getKlines', () => {
  it('拉取 5m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v5/market/kline',
        body: {
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [
              ['1725000000000', '62000.0', '62600.0', '61900.0', '62500.0', '250.0', '15625000.0'],
            ],
          },
        },
      },
    ])
    const client = new BybitRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('BTCUSDT', '5m', 10)

    expect(urls[0]).toContain('interval=5')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 62000.0,
      close: 62500.0,
      high: 62600.0,
      low: 61900.0,
      volume: 250.0,
    })
  })
})
