import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  QmtRestClient,
  toQmtCode,
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

describe('QmtRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(toQmtCode('600519')).toBe('600519.SH')
    expect(toQmtCode('000001')).toBe('000001.SZ')
    expect(toQmtCode('600519.SH')).toBe('600519.SH')
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('QmtRestClient.getTicker', () => {
  it('从本地网关拉取 Ticker', async () => {
    const { impl } = stubFetch([
      {
        match: '/api/v1/market/ticker',
        body: {
          code: 0,
          data: {
            lastPrice: 1750.5,
            volume: 20000,
            timestamp: 1725000000000,
          },
        },
      },
    ])
    const client = new QmtRestClient({ fetchImpl: impl, gatewayUrl: 'http://127.0.0.1:5800' })
    const ticker = await client.getTicker('600519.SH')

    expect(ticker.symbol).toBe('600519.SH')
    expect(ticker.price).toBe(1750.5)
    expect(ticker.volume).toBe(20000)
  })
})
