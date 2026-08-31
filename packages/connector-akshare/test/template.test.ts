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

describe('AkshareRestClient.getNorthboundFlow', () => {
  it('拉取北向资金流向', async () => {
    const { impl } = stubFetch([
      {
        match: 'kamt.kline',
        body: {
          data: {
            s2n: [
              '2026-08-31,250000.5,150000.2,400000.7',
            ],
          },
        },
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })
    const flow = await client.getNorthboundFlow()

    expect(flow).toHaveLength(1)
    expect(flow[0]).toEqual({
      date: '2026-08-31',
      hgtNet: 250000.5,
      sgtNet: 150000.2,
      totalNet: 400000.7,
    })
  })
})

describe('AkshareRestClient.getSectorFundFlow', () => {
  it('拉取板块资金流', async () => {
    const { impl } = stubFetch([
      {
        match: 'clist/get',
        body: {
          data: {
            diff: [
              { f14: '半导体', f3: 3.45, f62: 1250000000 },
            ],
          },
        },
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })
    const list = await client.getSectorFundFlow()

    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({
      name: '半导体',
      changePercent: 3.45,
      mainNetInflow: 1250000000,
    })
  })
})
