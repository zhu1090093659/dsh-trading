import { describe, expect, it } from 'vitest'
import {
  AkshareRestClient,
  INTERVAL_VOCABULARY,
  toEastmoneySecid,
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

describe('AkshareRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(toEastmoneySecid('600519')).toEqual({ secid: '1.600519', canonical: '600519.SH' })
    expect(toEastmoneySecid('000001')).toEqual({ secid: '0.000001', canonical: '000001.SZ' })
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('AkshareRestClient.getTicker', () => {
  it('拉取并解析 A 股 Ticker（分精度价格除以 100）', async () => {
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: {
          data: {
            f43: 175050,
            f47: 25000,
            f86: 1725000000,
          },
        },
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')

    expect(ticker).toEqual({
      symbol: '600519.SH',
      price: 1750.5,
      volume: 25000,
      timestamp: 1725000000000,
    })
  })
})

describe('AkshareRestClient.getSectorFundFlow', () => {
  it('拉取板块资金流（f3 涨跌幅除以 100）', async () => {
    const { impl } = stubFetch([
      {
        match: 'clist/get',
        body: {
          data: {
            diff: [
              { f14: '半导体', f3: 345, f62: 1250000000 },
              { f14: '航空机场', f3: -120, f62: -50000000 },
            ],
          },
        },
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })
    const list = await client.getSectorFundFlow()

    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      name: '半导体',
      changePercent: 3.45,
      mainNetInflow: 1250000000,
    })
    expect(list[1]).toEqual({
      name: '航空机场',
      changePercent: -1.2,
      mainNetInflow: -50000000,
    })
  })
})
