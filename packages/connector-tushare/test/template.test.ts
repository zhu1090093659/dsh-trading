import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  toTushareCode,
  TushareRestClient,
} from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const urls: string[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    const bodyText = typeof init?.body === 'string' ? init.body : ''
    const route = routes.find((r) => url.includes(r.match) || bodyText.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url} body: ${bodyText}`)
    return jsonResponse(route.body, route.status)
  }) as typeof fetch
  return { impl, urls }
}

describe('TushareRestClient 符号与周期映射', () => {
  it('代码格式化为标准 ts_code', () => {
    expect(toTushareCode('600519')).toBe('600519.SH')
    expect(toTushareCode('000001')).toBe('000001.SZ')
    expect(toTushareCode('600519.SH')).toBe('600519.SH')
    expect(toTushareCode('832023')).toBe('832023.BJ')
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('TushareRestClient.getTicker', () => {
  it('拉取并解析日行情', async () => {
    const { impl } = stubFetch([
      {
        match: 'daily',
        body: {
          code: 0,
          msg: null,
          data: {
            fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
            items: [
              ['600519.SH', '20260831', 1750.0, 1760.0, 1745.0, 1755.0, 30000, 520000000],
            ],
          },
        },
      },
    ])
    const client = new TushareRestClient({ fetchImpl: impl, token: 'test-token' })
    const ticker = await client.getTicker('600519.SH')

    expect(ticker.symbol).toBe('600519.SH')
    expect(ticker.price).toBe(1755.0)
    expect(ticker.volume).toBe(30000)
  })
})

describe('TushareRestClient.getKlines', () => {
  it('拉取日K线', async () => {
    const { impl } = stubFetch([
      {
        match: 'daily',
        body: {
          code: 0,
          msg: null,
          data: {
            fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol'],
            items: [
              ['600519.SH', '20260831', 1750.0, 1760.0, 1745.0, 1755.0, 30000],
            ],
          },
        },
      },
    ])
    const client = new TushareRestClient({ fetchImpl: impl, token: 'test-token' })
    const klines = await client.getKlines('600519.SH', '1d', 10)

    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 1750.0,
      close: 1755.0,
      high: 1760.0,
      low: 1745.0,
      volume: 30000,
    })
  })
})

describe('TushareRestClient.getDailyBasic', () => {
  it('拉取估值基本面指标', async () => {
    const { impl } = stubFetch([
      {
        match: 'daily_basic',
        body: {
          code: 0,
          msg: null,
          data: {
            fields: ['ts_code', 'trade_date', 'pe', 'pb', 'turnover_rate', 'total_mv'],
            items: [
              ['600519.SH', '20260831', 28.5, 9.2, 0.45, 220000000],
            ],
          },
        },
      },
    ])
    const client = new TushareRestClient({ fetchImpl: impl, token: 'test-token' })
    const basic = await client.getDailyBasic('600519.SH')

    expect(basic.pe).toBe(28.5)
    expect(basic.pb).toBe(9.2)
  })
})
