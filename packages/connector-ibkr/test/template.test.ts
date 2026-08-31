import { describe, expect, it } from 'vitest'
import {
  IbkrRestClient,
  INTERVAL_VOCABULARY,
  normalizeUsSymbol,
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

describe('IbkrRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(normalizeUsSymbol('aapl')).toBe('AAPL')
    expect(normalizeUsSymbol('NVDA')).toBe('NVDA')
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('IbkrRestClient.getTicker', () => {
  it('从 Gateway 拉取快照', async () => {
    const { impl } = stubFetch([
      {
        match: '/iserver/marketdata/snapshot',
        body: [
          {
            conid: 265598,
            31: '220.50',
            84: '220.45',
            86: '220.55',
          },
        ],
      },
    ])
    const client = new IbkrRestClient({ fetchImpl: impl, gatewayUrl: 'https://127.0.0.1:5000/v1/api' })
    const ticker = await client.getTicker('AAPL')

    expect(ticker.symbol).toBe('AAPL')
    expect(ticker.price).toBe(220.5)
  })
})
