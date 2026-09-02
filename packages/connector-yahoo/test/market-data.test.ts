import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  YahooRestClient,
  TradingServiceError,
  normalizeYahooSymbol,
  parseChartBars,
} from '../src/rest.js'

// 夹具为 Yahoo v8 chart 真实响应形态（2026-08-29 本出口网络实测，证据
// spikes/impl-us-yahoo/*.json：meta + timestamp[] + indicators.quote[0] 对齐数组，
// null 行可能出现须丢弃）。
const AAPL_DAILY = {
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          regularMarketPrice: 319.7,
          regularMarketTime: 1788019201,
          regularMarketVolume: 41234500,
          chartPreviousClose: 310.34,
          exchangeTimezoneName: 'America/New_York',
        },
        timestamp: [Date.UTC(2026, 7, 26) / 1000, Date.UTC(2026, 7, 27) / 1000, Date.UTC(2026, 7, 28) / 1000],
        indicators: {
          quote: [
            {
              open: [310.5, null, 316.0],
              high: [311.9, 315.2, 322.37],
              low: [308.1, 312.0, 315.45],
              close: [310.34, null, 319.7],
              volume: [34024500, 32419200, 41234500],
            },
          ],
        },
      },
    ],
  },
}

const AAPL_60M = {
  chart: {
    result: [
      {
        meta: { currency: 'USD', regularMarketPrice: 319.7, regularMarketTime: 1788019201 },
        timestamp: [Date.UTC(2026, 7, 28, 18, 30) / 1000, Date.UTC(2026, 7, 28, 19, 30) / 1000],
        indicators: {
          quote: [
            { open: [318.9, 319.2], high: [319.6, 319.9], low: [318.4, 319.0], close: [319.55, 319.7], volume: [3252611, 3423783] },
          ],
        },
      },
    ],
  },
}

/** 返回按 URL 分发的 fetch 桩，并记录全部请求 URL 与 User-Agent。 */
function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const requests: Array<{ url: string; ua?: string }> = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, ua: new Headers(init?.headers).get('user-agent') ?? undefined })
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return new Response(body, { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { impl, requests }
}

describe('normalizeYahooSymbol', () => {
  it('upper-cases plain and hyphenated tickers', () => {
    expect(normalizeYahooSymbol('AAPL')).toBe('AAPL')
    expect(normalizeYahooSymbol(' aapl ')).toBe('AAPL')
    expect(normalizeYahooSymbol('brk-b')).toBe('BRK-B')
    expect(normalizeYahooSymbol('7203.T')).toBe('7203.T')
    expect(normalizeYahooSymbol('^GSPC')).toBe('^GSPC')
  })

  it('rejects empty or malformed input', () => {
    expect(() => normalizeYahooSymbol('')).toThrow(TradingServiceError)
    expect(() => normalizeYahooSymbol('  ')).toThrow(TradingServiceError)
    expect(() => normalizeYahooSymbol('no spaces allowed!!')).toThrow(TradingServiceError)
  })
})

describe('YahooRestClient.getKlines', () => {
  it('parses daily bars, skips null rows, and requests interval/range + UA header', async () => {
    const { impl, requests } = stubFetch([{ match: '/v8/finance/chart/AAPL', body: AAPL_DAILY }])
    const client = new YahooRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('aapl', '1d')

    expect(klines).toHaveLength(2) // 中间 null 行被丢弃
    expect(klines[0]).toEqual({
      openTime: Date.UTC(2026, 7, 26),
      open: 310.5,
      high: 311.9,
      low: 308.1,
      close: 310.34,
      volume: 34024500,
      closeTime: Date.UTC(2026, 7, 26) + 86_400_000 - 1,
    })
    expect(klines[1]!.close).toBe(319.7)
    expect(requests[0]!.url).toContain('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=3y')
    expect(requests[0]!.ua).toBe('Mozilla/5.0')
  })

  it('maps 1h → interval=60m with intraday closeTime = open + 1h', async () => {
    const { impl, requests } = stubFetch([{ match: '/v8/finance/chart/AAPL', body: AAPL_60M }])
    const client = new YahooRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('AAPL', '1h')

    expect(requests[0]!.url).toContain('interval=60m&range=3mo')
    expect(klines[0]!.openTime).toBe(Date.UTC(2026, 7, 28, 18, 30))
    expect(klines[0]!.closeTime).toBe(Date.UTC(2026, 7, 28, 18, 30) + 3_600_000 - 1)
    expect(INTERVAL_VOCABULARY).toEqual(['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'])
  })

  it('trims to the requested limit on the newest side (service layer contract)', async () => {
    const { impl } = stubFetch([{ match: '/v8/finance/chart/AAPL', body: AAPL_DAILY }])
    const client = new YahooRestClient({ fetchImpl: impl })
    const all = await client.getKlines('AAPL', '1d')
    expect(all.slice(-1).map((k) => k.close)).toEqual([319.7])
  })

  it('rejects unsupported intervals locally (TRADING_UNSUPPORTED_INTERVAL, no fetch)', async () => {
    const { impl, requests } = stubFetch([])
    const client = new YahooRestClient({ fetchImpl: impl })
    await expect(client.getKlines('AAPL', '3m')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    await expect(client.getKlines('AAPL', '2h')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    expect(requests).toHaveLength(0)
  })

  it('maps HTTP 429 to TRADING_RATE_LIMITED and other non-OK to TRADING_EXCHANGE_ERROR', async () => {
    const { impl } = stubFetch([
      { match: 'range=3y', body: 'rate limited', status: 429 },
    ])
    const client = new YahooRestClient({ fetchImpl: impl })
    await expect(client.getKlines('AAPL', '1d')).rejects.toMatchObject({ code: 'TRADING_RATE_LIMITED' })
    const { impl: impl2 } = stubFetch([{ match: '/v8/finance/chart', body: '<html>no</html>', status: 503 }])
    await expect(new YahooRestClient({ fetchImpl: impl2 }).getKlines('AAPL', '1d')).rejects.toMatchObject({
      code: 'TRADING_EXCHANGE_ERROR',
    })
  })

  it('maps chart.error payloads to TRADING_EXCHANGE_ERROR', async () => {
    const { impl } = stubFetch([
      { match: '/v8/finance/chart', body: { chart: { error: { code: 'Bad Request', description: 'Invalid input' } } } },
    ])
    const client = new YahooRestClient({ fetchImpl: impl })
    await expect(client.getKlines('AAPL', '1d')).rejects.toMatchObject({
      code: 'TRADING_EXCHANGE_ERROR',
      message: expect.stringContaining('Invalid input'),
    })
  })

  it('maps empty results (unknown/delisted symbol) to TRADING_UNSUPPORTED_SYMBOL', async () => {
    const { impl } = stubFetch([{ match: '/v8/finance/chart', body: { chart: { result: [] } } }])
    const client = new YahooRestClient({ fetchImpl: impl })
    await expect(client.getKlines('ZZZZZZ', '1d')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })

  it('rejects empty symbols before any network call', async () => {
    const { impl, requests } = stubFetch([])
    const client = new YahooRestClient({ fetchImpl: impl })
    await expect(client.getKlines('  ', '1d')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(requests).toHaveLength(0)
  })

  it('parseChartBars falls back to close for missing o/h/l and 0 for null volume', () => {
    const bars = parseChartBars(
      {
        meta: {},
        timestamp: [1000, 2000],
        indicators: { quote: [{ close: [10, 11] }] },
      },
      '1d',
    )
    expect(bars[0]).toMatchObject({ open: 10, high: 10, low: 10, close: 10, volume: 0 })
  })
})

describe('YahooRestClient.getTicker', () => {
  it('prefers meta.regularMarketPrice/Time/Volume/chartPreviousClose over bar-derived values', async () => {
    const { impl, requests } = stubFetch([{ match: '/v8/finance/chart/AAPL', body: AAPL_DAILY }])
    const client = new YahooRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('aapl')

    expect(ticker).toMatchObject({
      symbol: 'AAPL',
      price: 319.7,
      volume: 41234500,
      timestamp: 1788019201 * 1000,
      prevClose: 310.34,
    })
    expect(ticker.changePercent).toBeCloseTo(3.016, 2)
    expect(requests).toHaveLength(1) // 单请求：1d/1d（昨收锚点依赖 range=1d 窗口语义）
    expect(requests[0]!.url).toContain('interval=1d&range=1d')
  })

  it('falls back to the last bar when meta price/time/volume/prevClose are absent', async () => {
    const fixture = structuredClone(AAPL_DAILY)
    for (const key of ['regularMarketPrice', 'regularMarketTime', 'regularMarketVolume', 'chartPreviousClose']) {
      delete (fixture.chart.result[0]!.meta as Record<string, unknown>)[key]!
    }
    const { impl } = stubFetch([{ match: '/v8/finance/chart', body: fixture }])
    const client = new YahooRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('AAPL')
    expect(ticker.price).toBe(319.7)
    expect(ticker.volume).toBe(41234500)
    expect(ticker.prevClose).toBe(310.34) // bars[len-2]
    expect(ticker.timestamp).toBe(Date.UTC(2026, 7, 28) + 86_400_000 - 1)
  })

  it('returns official prevClose via meta anchor even when the daily series skips a session (2026-09-01 vintage)', async () => {
    // 真实缺口形态（spikes/impl-us-yahoo/probe-prevclose-20260901-output.txt）：
    // 日 K 序列整体缺 08-28 bar，昨收 319.7 只存在于 meta.chartPreviousClose（range=1d 窗口）。
    const lagged = {
      chart: {
        result: [
          {
            meta: {
              currency: 'USD',
              regularMarketPrice: 316.85,
              regularMarketTime: Date.UTC(2026, 7, 31, 20, 0, 1) / 1000,
              regularMarketVolume: 40667429,
              chartPreviousClose: 319.7,
              exchangeTimezoneName: 'America/New_York',
            },
            timestamp: [Date.UTC(2026, 7, 31) / 1000],
            indicators: {
              quote: [
                { open: [319.56], high: [321.2349853515625], low: [312.79998779296875], close: [316.8500061035156], volume: [40667429] },
              ],
            },
          },
        ],
      },
    }
    const { impl } = stubFetch([{ match: '/v8/finance/chart/AAPL', body: lagged }])
    const client = new YahooRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('AAPL')
    expect(ticker.price).toBe(316.85)
    expect(ticker.prevClose).toBe(319.7)
    expect(ticker.volume).toBe(40667429)
    expect(ticker.changePercent).toBeCloseTo(-0.892, 2)
  })
})
