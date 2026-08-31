import { describe, expect, it } from 'vitest'
import {
  FinnhubRestClient,
  INTERVAL_VOCABULARY,
  normalizeUsSymbol,
  toFinnhubResolution,
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

describe('FinnhubRestClient 符号与周期映射', () => {
  it('美股代码归一化', () => {
    expect(normalizeUsSymbol('nvda')).toBe('NVDA')
    expect(normalizeUsSymbol(' MSFT ')).toBe('MSFT')
  })

  it('支持的 interval 词汇与 Finnhub resolution 映射', () => {
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(toFinnhubResolution('1m')).toBe('1')
    expect(toFinnhubResolution('5m')).toBe('5')
    expect(toFinnhubResolution('1h')).toBe('60')
    expect(toFinnhubResolution('1d')).toBe('D')
  })
})

describe('FinnhubRestClient.getTicker', () => {
  it('拉取并解析 Finnhub Quote', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/quote?symbol=NVDA',
        body: {
          c: 125.8,
          d: 2.3,
          dp: 1.86,
          h: 126.5,
          l: 124.0,
          o: 124.2,
          pc: 123.5,
          t: 1725000000,
        },
      },
    ])
    const client = new FinnhubRestClient({ fetchImpl: impl, apiKey: 'test-token' })
    const ticker = await client.getTicker('NVDA')

    expect(urls[0]).toContain('/quote?symbol=NVDA')
    expect(urls[0]).toContain('token=test-token')
    expect(ticker).toEqual({
      symbol: 'NVDA',
      price: 125.8,
      timestamp: 1725000000000,
    })
  })
})

describe('FinnhubRestClient.getKlines', () => {
  it('拉取 5m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/stock/candle',
        body: {
          s: 'ok',
          c: [125.0],
          h: [125.5],
          l: [124.8],
          o: [124.9],
          t: [1725000000],
          v: [80000],
        },
      },
    ])
    const client = new FinnhubRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('NVDA', '5m', 10)

    expect(urls[0]).toContain('resolution=5')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 124.9,
      close: 125.0,
      high: 125.5,
      low: 124.8,
      volume: 80000,
    })
  })
})

describe('FinnhubRestClient.getNews', () => {
  it('拉取公司新闻', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/company-news',
        body: [
          {
            category: 'company',
            headline: 'NVIDIA Announces New Chip',
            summary: 'Details of the announcement...',
          },
        ],
      },
    ])
    const client = new FinnhubRestClient({ fetchImpl: impl })
    const news = await client.getNews('NVDA')

    expect(urls[0]).toContain('/company-news?symbol=NVDA')
    expect(news).toHaveLength(1)
    expect(news[0].headline).toBe('NVIDIA Announces New Chip')
  })
})
