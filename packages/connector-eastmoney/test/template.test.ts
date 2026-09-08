import { describe, expect, it } from 'vitest'
import {
  EastmoneyRestClient,
  INTERVAL_VOCABULARY,
  mapIntervalToKlt,
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

describe('EastmoneyRestClient 符号与周期映射', () => {
  it('A股标准代码转东财 secid 与规范形', () => {
    expect(toEastmoneySecid('600519.SH')).toEqual({ secid: '1.600519', canonical: '600519.SH', market: 'cn' })
    expect(toEastmoneySecid('000001.SZ')).toEqual({ secid: '0.000001', canonical: '000001.SZ', market: 'cn' })
    expect(toEastmoneySecid('600519')).toEqual({ secid: '1.600519', canonical: '600519.SH', market: 'cn' })
    expect(toEastmoneySecid('000001')).toEqual({ secid: '0.000001', canonical: '000001.SZ', market: 'cn' })
    expect(toEastmoneySecid('832023.BJ')).toEqual({ secid: '0.832023', canonical: '832023.BJ', market: 'cn' })
  })

  it('港股代码转东财 secid（116 前缀；形态 00700.HK / HK00700 / 裸 5 位）', () => {
    expect(toEastmoneySecid('00700.HK')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    expect(toEastmoneySecid('HK00700')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    expect(toEastmoneySecid('02714.HK')).toEqual({ secid: '116.02714', canonical: '02714.HK', market: 'hk' })
    expect(toEastmoneySecid('700')).toEqual({ secid: '0.700', canonical: '700.SZ', market: 'cn' }) // 裸 3 位不进 HK 分支（走原 CN 兜底）
    expect(toEastmoneySecid('00700')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
  })

  it('支持的 interval 词汇包含 1m/5m/15m/30m/1h/1d/1w/1M', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('15m')
    expect(INTERVAL_VOCABULARY).toContain('30m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(INTERVAL_VOCABULARY).toContain('1d')
    expect(mapIntervalToKlt('5m')).toBe('5')
    expect(mapIntervalToKlt('1h')).toBe('60')
    expect(mapIntervalToKlt('1d')).toBe('101')
  })
})

describe('EastmoneyRestClient.getTicker', () => {
  it('拉取并解析 A 股 Ticker 快照（分精度整数除以 100，含官方昨收/涨跌幅）', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: {
          data: {
            f43: 175050,
            f47: 25000,
            f58: '贵州茅台',
            f60: 174800,
            f86: 1725000000,
            f170: 15,
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')

    expect(urls[0]).toContain('secid=1.600519')
    expect(urls[0]).toContain('f60')
    expect(ticker).toEqual({
      symbol: '600519.SH',
      name: '贵州茅台',
      price: 1750.5,
      volume: 25000,
      timestamp: 1725000000000,
      prevClose: 1748,
      changePercent: 0.15,
    })
  })

  it('处理 "-" 停牌/无数据占位符', async () => {
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: {
          data: {
            f43: '-',
            f47: 0,
            f58: '退市标的',
            f86: 1725000000,
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')
    expect(ticker.price).toBe(0)
  })

  it('防回归断言：茅台 ticker price 与最近 K 线 close 在 ±5% 以内', async () => {
    const klineClose = 1755.0
    const tickerPriceRaw = 175050 // 上游返回 175050 即 1750.50 元
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: { data: { f43: tickerPriceRaw, f47: 25000, f58: '贵州茅台', f86: 1725000000 } },
      },
      {
        match: '/api/qt/stock/kline/get',
        body: { data: { klines: [`2026-08-31 09:35,1750.0,${klineClose},1758.0,1748.0,5000,87500000.0,0.57`] } },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')
    const klines = await client.getKlines('600519.SH', '5m', 1)

    const ratio = Math.abs(ticker.price - klines[0].close) / klines[0].close
    expect(ratio).toBeLessThan(0.05)
  })
})

describe('EastmoneyRestClient.getKlines', () => {
  it('拉取并解析 5m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/kline/get',
        body: {
          data: {
            klines: [
              '2026-08-31 09:35,1750.0,1755.0,1758.0,1748.0,5000,87500000.0,0.57',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('600519.SH', '5m', 10)

    expect(urls[0]).toContain('secid=1.600519')
    expect(urls[0]).toContain('klt=5')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 1750.0,
      close: 1755.0,
      high: 1758.0,
      low: 1748.0,
      volume: 5000,
    })
  })
})

describe('EastmoneyRestClient.listInstruments', () => {
  it('搜索股票代码联想', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/suggest/get',
        body: {
          QuotationCodeTable: {
            Data: [
              { Code: '600519', Name: '贵州茅台', SecurityTypeName: '沪A' },
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const results = await client.listInstruments('茅台')

    expect(urls[0]).toContain('input=%E8%8C%85%E5%8F%B0')
    expect(results).toEqual([
      { symbol: '600519.SH', name: '贵州茅台' },
    ])
  })
})


describe('EastmoneyRestClient 港股面（2026-09-08，实证 spikes/impl-eastmoney-hk/）', () => {
  it('港股 ticker：价格字段 ×1000（decimal=3），涨跌幅仍 ×100', async () => {
    // 2026-09-08 11:23 实测：f43=437600 → 437.600，f60=438400 → 438.4，f170=-18 → -0.18%
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: { data: { f43: 437600, f44: 439200, f45: 435000, f46: 437000, f47: 4239248, f58: '腾讯控股', f60: 438400, f86: 1788837793, f170: -18 } },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('00700.HK')
    expect(urls[0]).toContain('secid=116.00700')
    expect(ticker).toEqual({
      symbol: '00700.HK',
      name: '腾讯控股',
      price: 437.6,
      volume: 4239248,
      timestamp: 1788837793000,
      prevClose: 438.4,
      changePercent: -0.18,
    })
  })

  it('港股 1m 走 trends2 分时端点，时间按 UTC+8 墙钟锚定（与机器时区无关）', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/trends2/get',
        body: {
          data: {
            trends: [
              '2026-09-08 09:30,437.000,437.000,437.400,437.000,159900,69876300.000,437.0000',
              '2026-09-08 09:31,437.400,436.200,437.800,435.800,183300,80009040.000,436.7288',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('00700.HK', '1m', 500)
    expect(urls[0]).toContain('secid=116.00700')
    expect(urls[0]).toContain('ndays=1')
    expect(klines).toHaveLength(2)
    // 2026-09-08 09:30 UTC+8 = 2026-09-08 01:30 UTC
    expect(klines[0].openTime).toBe(Date.UTC(2026, 8, 8, 1, 30))
    expect(klines[0]).toMatchObject({ open: 437, close: 437, high: 437.4, low: 437, volume: 159900 })
    expect(klines[1]).toMatchObject({ open: 437.4, close: 436.2 })
  })

  it('港股 5m 走 kline/get（klt=5，secid=116）', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/kline/get',
        body: { data: { klines: ['2026-09-08 11:25,437.800,437.600,437.800,437.600,15400,6741180.000,0.05'] } },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('00700.HK', '5m', 4)
    expect(urls[0]).toContain('secid=116.00700')
    expect(urls[0]).toContain('klt=5')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ open: 437.8, close: 437.6, volume: 15400 })
  })
})
