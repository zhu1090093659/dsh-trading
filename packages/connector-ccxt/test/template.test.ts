import { describe, expect, it } from 'vitest'
import {
  CcxtRestClient,
  INTERVAL_VOCABULARY,
  normalizeSymbol,
  SUPPORTED_EXCHANGES,
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

describe('CcxtRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(normalizeSymbol('BTC/USDT')).toBe('BTCUSDT')
    expect(normalizeSymbol('eth-usdt')).toBe('ETHUSDT')
  })

  it('支持的 interval 词汇与交易所', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
    expect(SUPPORTED_EXCHANGES).toContain('binance')
    expect(SUPPORTED_EXCHANGES).toContain('bybit')
    expect(SUPPORTED_EXCHANGES).toContain('okx')
    expect(SUPPORTED_EXCHANGES).toContain('gateio')
  })
})

describe('CcxtRestClient.getTicker', () => {
  it('从 Binance 拉取 Ticker', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/v3/ticker/24hr',
        body: {
          symbol: 'BTCUSDT',
          lastPrice: '64000.5',
          volume: '35000.2',
          closeTime: 1725000000000,
        },
      },
    ])
    const client = new CcxtRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('BTCUSDT', 'binance')

    expect(urls[0]).toContain('symbol=BTCUSDT')
    expect(ticker).toEqual({
      symbol: 'BTCUSDT',
      price: 64000.5,
      volume: 35000.2,
      timestamp: 1725000000000,
    })
  })
})
