import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HiThinkRestClient } from '../src/rest.js'
import { aggregateDailyKlines, aggregateMinutePoints, dailyBarToKline } from '../src/kline.js'
import { HiThinkMarketDataService } from '../src/index.js'
import { HiThinkFuturesMarketDataService, normalizeFuturesCode } from '../src/futures.js'

function makeServiceCtx(): Context {
  return {
    get: () => undefined,
    reflect: { provide: () => {} },
  } as unknown as Context
}

interface Route {
  status?: number
  body: unknown
}

function stubFetch(routes: Record<string, Route>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const path = new URL(url).pathname + new URL(url).search
    const matched = Object.keys(routes).find((k) => path.startsWith(k))
    if (matched === undefined) throw new Error(`unexpected request: ${url}`)
    const route = routes[matched]
    return {
      ok: (route.status ?? 200) >= 200 && (route.status ?? 200) < 300,
      status: route.status ?? 200,
      json: async () => route.body,
    }
  }) as typeof fetch
  return { impl, urls }
}

const DAY_MS = 86_400_000

describe('K 线聚合助手（纯函数）', () => {
  it('dailyBarToKline: closeTime = openTime + 1d - 1', () => {
    const bar = dailyBarToKline(1_716_134_400_000, 10, 12, 9, 11, 100)
    expect(bar.closeTime).toBe(1_716_134_400_000 + DAY_MS - 1)
    expect(bar).toMatchObject({ open: 10, high: 12, low: 9, close: 11, volume: 100 })
  })

  it('aggregateDailyKlines 1w: 跨周边界按 ISO 周聚合（周一为起点）', () => {
    // 2024-05-20（周一）00:00 +08 与 2024-05-24（周五）同一周；2024-05-27（周一）下一周
    const mon = 1_716_134_400_000
    const fri = mon + 4 * DAY_MS
    const nextMon = mon + 7 * DAY_MS
    const daily = [
      dailyBarToKline(mon, 10, 11, 9, 10.5, 100),
      dailyBarToKline(fri, 10.5, 12, 10, 11.5, 150),
      dailyBarToKline(nextMon, 11.5, 13, 11, 12.5, 120),
    ]
    const weekly = aggregateDailyKlines(daily, '1w')
    expect(weekly).toHaveLength(2)
    expect(weekly[0]).toMatchObject({ openTime: mon, open: 10, high: 12, low: 9, close: 11.5, volume: 250 })
    expect(weekly[1]).toMatchObject({ openTime: nextMon, open: 11.5, close: 12.5 })
  })

  it('aggregateDailyKlines 1M: 按东八区自然月聚合', () => {
    // 2024-05-20 与 2024-05-31 同月；2024-06-03 下月
    const may = 1_716_134_400_000
    const jun = may + 14 * DAY_MS
    const monthly = aggregateDailyKlines([
      dailyBarToKline(may, 1, 2, 0.5, 1.8, 10),
      dailyBarToKline(jun, 2, 3, 1.5, 2.8, 20),
    ], '1M')
    expect(monthly).toHaveLength(2)
  })

  it('aggregateMinutePoints: 按 N 分钟分桶聚合 OHLC 与量', () => {
    const base = 1_789_036_800_000
    const points = [
      { timestamp: base, price: 100, volume: 10 },
      { timestamp: base + 60_000, price: 102, volume: 20 },
      { timestamp: base + 120_000, price: 98, volume: 5 },
      { timestamp: base + 300_000, price: 101, volume: 8 },
    ]
    const bars = aggregateMinutePoints(points, 5)
    expect(bars).toHaveLength(2)
    expect(bars[0]).toMatchObject({ openTime: base, open: 100, high: 102, low: 98, close: 98, volume: 35 })
    expect(bars[0]?.closeTime).toBe(base + 5 * 60_000 - 1)
    expect(bars[1]).toMatchObject({ open: 101, volume: 8 })
  })
})

describe('HiThinkMarketDataService.getKlines（A 股）', () => {
  it('1d: 直连 /prices/historical 并映射为 Kline 升序序列', async () => {
    const { impl, urls } = stubFetch({
      '/api/a-share/prices/historical': {
        body: {
          code: 0,
          message: 'success',
          data: {
            timestamp: 1_727_000_000_000,
            item: [
              { date_ms: 1_716_134_400_000, open_price: 10, high_price: 11, low_price: 9, close_price: 10.5, volume: 100 },
              { date_ms: 1_716_220_800_000, open_price: 10.5, high_price: 12, low_price: 10, close_price: 11.5, volume: 200 },
            ],
          },
        },
      },
    })
    const service = new HiThinkMarketDataService(makeServiceCtx(), { apiKey: 'k', fetchImpl: impl })
    const klines = await service.getKlines('600519.SH', '1d', 10)
    expect(klines).toHaveLength(2)
    expect(klines[1]).toMatchObject({ open: 10.5, close: 11.5, volume: 200 })
    expect(urls[0]).toContain('interval=1d')
    expect(urls[0]).toContain('thscode=600519.SH')
    expect(urls[0]).toContain('adjust=forward')
  })

  it('分钟级周期：抛 TRADING_UNSUPPORTED_INTERVAL（上游高频模块未开放）', async () => {
    const { impl } = stubFetch({})
    const service = new HiThinkMarketDataService(makeServiceCtx(), { apiKey: 'k', fetchImpl: impl })
    await expect(service.getKlines('600519.SH', '5m', 10)).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
  })

  it('1w: 由日线本地聚合并截尾 limit 根', async () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({
      date_ms: 1_716_134_400_000 + i * DAY_MS,
      open_price: 1,
      high_price: 2,
      low_price: 0.5,
      close_price: 1.5,
      volume: 10,
    }))
    const { impl } = stubFetch({ '/api/a-share/prices/historical': { body: { code: 0, message: 'success', data: { timestamp: null, item: bars } } } })
    const service = new HiThinkMarketDataService(makeServiceCtx(), { apiKey: 'k', fetchImpl: impl })
    const klines = await service.getKlines('600519.SH', '1w', 4)
    expect(klines.length).toBeGreaterThan(0)
    expect(klines.length).toBeLessThanOrEqual(4)
  })
})

describe('HiThinkFuturesMarketDataService', () => {
  it('normalizeFuturesCode: 大写与去空白，后缀透传', () => {
    expect(normalizeFuturesCode(' cu2601.SHF ')).toBe('CU2601.SHF')
    expect(normalizeFuturesCode('RB2610')).toBe('RB2610')
  })

  it('getKlines 1d: 直连 /api/futures/prices/daily', async () => {
    const { impl, urls } = stubFetch({
      '/api/futures/prices/daily': {
        body: {
          code: 0,
          message: 'success',
          data: {
            timestamp: 1_789_036_800_000,
            thscode: 'CU2601.SHF',
            interval: '1d',
            item: [
              { timestamp: 1_788_950_400_000, open_price: 78000, high_price: 78400, low_price: 77800, close_price: 78200, volume: 120000 },
            ],
          },
        },
      },
    })
    const service = new HiThinkFuturesMarketDataService(makeServiceCtx(), { apiKey: 'k', fetchImpl: impl })
    const klines = await service.getKlines('CU2601.SHF', '1d', 10)
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ open: 78000, high: 78400, low: 77800, close: 78200, volume: 120000 })
    expect(urls[0]).toContain('/api/futures/prices/daily?thscode=CU2601.SHF')
  })

  it('getKlines 5m: 由当日分时点聚合', async () => {
    const base = 1_789_036_800_000
    const { impl } = stubFetch({
      '/api/futures/prices/intraday': {
        body: {
          code: 0,
          message: 'success',
          data: {
            timestamp: base,
            thscode: 'CU2601.SHF',
            date: '2026-09-10',
            session: 'intraday',
            item: [
              { timestamp: base, price: 78200, volume: 12 },
              { timestamp: base + 60_000, price: 78300, volume: 8 },
              { timestamp: base + 300_000, price: 78250, volume: 6 },
            ],
          },
        },
      },
    })
    const service = new HiThinkFuturesMarketDataService(makeServiceCtx(), { apiKey: 'k', fetchImpl: impl })
    const klines = await service.getKlines('CU2601.SHF', '5m', 10)
    expect(klines).toHaveLength(2)
    expect(klines[0]).toMatchObject({ open: 78200, high: 78300, low: 78200, close: 78300, volume: 20 })
    expect(klines[1]).toMatchObject({ open: 78250, close: 78250, volume: 6 })
  })

  it('getTicker: 分时末点优先，prevClose 取自日K；分时为空回落日K收盘', async () => {
    const base = 1_789_036_800_000
    const { impl } = stubFetch({
      '/api/futures/prices/intraday': {
        body: {
          code: 0,
          message: 'success',
          data: { timestamp: base, thscode: 'CU2601.SHF', date: '2026-09-10', session: 'intraday', item: [{ timestamp: base + 600_000, price: 78350, volume: 3 }] },
        },
      },
      '/api/futures/prices/daily': {
        body: {
          code: 0,
          message: 'success',
          data: {
            timestamp: base,
            thscode: 'CU2601.SHF',
            interval: '1d',
            item: [
              { timestamp: base - DAY_MS, open_price: 77900, high_price: 78100, low_price: 77700, close_price: 78000, volume: 100000 },
              { timestamp: base, open_price: 78100, high_price: 78400, low_price: 78000, close_price: 78200, volume: 90000 },
            ],
          },
        },
      },
    })
    const service = new HiThinkFuturesMarketDataService(makeServiceCtx(), { apiKey: 'k', fetchImpl: impl })
    const ticker = await service.getTicker('CU2601.SHF')
    expect(ticker.price).toBe(78350)
    expect(ticker.prevClose).toBe(78000)
    expect(ticker.volume).toBe(90000)

    const emptyIntraday = stubFetch({
      '/api/futures/prices/intraday': { body: { code: 0, message: 'success', data: { timestamp: null, thscode: 'CU2601.SHF', date: '2026-09-12', session: 'intraday', item: [] } } },
      '/api/futures/prices/daily': {
        body: {
          code: 0,
          message: 'success',
          data: { timestamp: base, thscode: 'CU2601.SHF', interval: '1d', item: [{ timestamp: base - DAY_MS, open_price: 77900, high_price: 78100, low_price: 77700, close_price: 78000, volume: 100000 }] },
        },
      },
    })
    const fallback = new HiThinkFuturesMarketDataService(makeServiceCtx(), { apiKey: 'k', fetchImpl: emptyIntraday.impl })
    const ticker2 = await fallback.getTicker('CU2601.SHF')
    expect(ticker2.price).toBe(78000)
  })

  it('listInstruments: 带 query 走跨资产检索；无 query 拉代码表并过滤已到期合约', async () => {
    const search = stubFetch({
      '/api/meta/tickers/search': {
        body: {
          code: 0,
          message: 'success',
          data: { timestamp: null, item: [{ thscode: 'RB2610.SHF', ticker: 'RB2610', name: '螺纹钢2610', asset_type: 'futures' }] },
        },
      },
    })
    const service = new HiThinkFuturesMarketDataService(makeServiceCtx(), { apiKey: 'k', fetchImpl: search.impl })
    const found = await service.listInstruments('螺纹')
    expect(found).toEqual([{ symbol: 'RB2610.SHF', name: '螺纹钢2610' }])
    expect(search.urls[0]).toContain('asset_type=futures')

    const list = stubFetch({
      '/api/meta/tickers/list': {
        body: {
          code: 0,
          message: 'success',
          data: {
            timestamp: null,
            item: [
              { thscode: 'CU2601.SHF', ticker: 'CU2601', name: '沪铜2601', asset_type: 'futures', last_trade_date: '2601-01-15' },
              { thscode: 'CU2603.SHF', ticker: 'CU2603', name: '沪铜2603', asset_type: 'futures', last_trade_date: null },
            ],
          },
        },
      },
    })
    const service2 = new HiThinkFuturesMarketDataService(makeServiceCtx(), { apiKey: 'k', fetchImpl: list.impl })
    const roster = await service2.listInstruments()
    expect(roster).toHaveLength(2)
  })

  it('apiKeyProvider: 惰性凭证源每请求解析（settings credentials 晚于 apply 亦生效）', async () => {
    const seenKeys: Array<string | undefined> = []
    const impl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      seenKeys.push(init?.headers?.['X-api-key'])
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, message: 'success', data: { timestamp: null, thscode: 'CU2601.SHF', interval: '1d', item: [] } }),
      }
    }) as unknown as typeof fetch
    let key: string | undefined
    const client = new HiThinkRestClient({ apiKeyProvider: () => key, fetchImpl: impl })

    key = undefined
    await client.getFuturesDailyKlines('CU2601.SHF', 5)
    expect(seenKeys[0]).toBeUndefined()

    key = 'late-key'
    await client.getFuturesDailyKlines('CU2601.SHF', 5)
    expect(seenKeys[1]).toBe('late-key')
  })

  it('HiThinkRestClient.getFuturesDailyKlines: limit>100 时携带 start/end 窗口', async () => {
    const { impl, urls } = stubFetch({
      '/api/futures/prices/daily': { body: { code: 0, message: 'success', data: { timestamp: null, thscode: 'CU2601.SHF', interval: '1d', item: [] } } },
    })
    const client = new HiThinkRestClient({ apiKey: 'k', fetchImpl: impl })
    const bars = await client.getFuturesDailyKlines('CU2601.SHF', 300)
    expect(bars).toEqual([])
    expect(urls[0]).toContain('start=')
    expect(urls[0]).toContain('end=')
  })
})
