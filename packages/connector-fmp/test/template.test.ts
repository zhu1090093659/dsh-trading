import { describe, expect, it } from 'vitest'
import {
  FmpRestClient,
  INTERVAL_VOCABULARY,
  normalizeUsSymbol,
  toFmpInterval,
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

describe('FmpRestClient 符号与周期映射', () => {
  it('美股代码归一化', () => {
    expect(normalizeUsSymbol('aapl')).toBe('AAPL')
    expect(normalizeUsSymbol(' TSLA ')).toBe('TSLA')
  })

  it('支持的 interval 词汇与 FMP 周期映射', () => {
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(toFmpInterval('5m')).toBe('5min')
    expect(toFmpInterval('1h')).toBe('1hour')
    expect(toFmpInterval('4h')).toBe('4hour')
  })
})

describe('FmpRestClient.getTicker', () => {
  it('拉取并解析美股 Quote', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/quote/AAPL',
        body: [
          {
            symbol: 'AAPL',
            price: 220.5,
            volume: 45000000,
            timestamp: 1725000000,
          },
        ],
      },
    ])
    const client = new FmpRestClient({ fetchImpl: impl, apiKey: 'test-key' })
    const ticker = await client.getTicker('AAPL')

    expect(urls[0]).toContain('/quote/AAPL')
    expect(urls[0]).toContain('apikey=test-key')
    expect(ticker).toEqual({
      symbol: 'AAPL',
      price: 220.5,
      volume: 45000000,
      timestamp: 1725000000000,
    })
  })
})

describe('FmpRestClient.getKlines', () => {
  it('拉取日内 5m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/historical-chart/5min/AAPL',
        body: [
          {
            date: '2026-08-31 09:35:00',
            open: 220.0,
            low: 219.8,
            high: 221.2,
            close: 221.0,
            volume: 150000,
          },
        ],
      },
    ])
    const client = new FmpRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('AAPL', '5m', 10)

    expect(urls[0]).toContain('/historical-chart/5min/AAPL')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 220.0,
      close: 221.0,
      high: 221.2,
      low: 219.8,
      volume: 150000,
    })
  })
})

describe('FmpRestClient.getProfile', () => {
  it('获取公司基本面 Profile', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/profile/AAPL',
        body: [
          {
            symbol: 'AAPL',
            companyName: 'Apple Inc.',
            industry: 'Consumer Electronics',
            sector: 'Technology',
            mktCap: 3400000000000,
          },
        ],
      },
    ])
    const client = new FmpRestClient({ fetchImpl: impl })
    const profile = await client.getProfile('AAPL')

    expect(urls[0]).toContain('/profile/AAPL')
    expect(profile.companyName).toBe('Apple Inc.')
  })
})
