import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  StooqRestClient,
  TradingServiceError,
  easternWallTimeToEpochMs,
  normalizeStooqSymbol,
} from '../src/rest.js'

// 夹具为 Stooq 真实 CSV 形态（Date,Open,High,Low,Close,Volume；2026-08-31 网络实测
// 本出口被拒，形态依据 Stooq 长期稳定的导出格式；真实联网验证证据见 spikes/impl-us/REPORT.md）。
const DAILY_CSV = [
  'Date,Open,High,Low,Close,Volume',
  '2026-08-27,225.5,230.1,224.8,229.87,55123400',
  '2026-08-28,230.0,233.6,229.9,232.14,60200100',
  '2026-08-31,231.5,234.2,230.7,233.5,48770200',
].join('\n')

const INTRADAY_CSV = [
  'Date,Open,High,Low,Close,Volume',
  '2026-08-28 09:30,230.0,230.4,229.8,230.2,1200400',
  '2026-08-28 10:30,230.2,231.0,230.1,230.9,986500',
].join('\n')

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } })
}

/** 返回按 query 分发的 fetch 桩，并记录全部请求 URL。 */
function stubFetch(routes: Array<{ match: string; body: string; status?: number }>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return textResponse(route.body, route.status)
  }) as typeof fetch
  return { impl, urls }
}

describe('normalizeStooqSymbol', () => {
  it('accepts AAPL and aapl.us, normalizes to lowercase .us', () => {
    expect(normalizeStooqSymbol('AAPL')).toBe('aapl.us')
    expect(normalizeStooqSymbol(' aapl.us ')).toBe('aapl.us')
    expect(normalizeStooqSymbol('MsFt')).toBe('msft.us')
  })

  it('keeps existing non-us suffixes and rejects malformed input', () => {
    expect(normalizeStooqSymbol('7203.T')).toBe('7203.t')
    expect(() => normalizeStooqSymbol('')).toThrow()
    expect(() => normalizeStooqSymbol('no spaces allowed!!')).toThrow(TradingServiceError)
  })
})

describe('easternWallTimeToEpochMs', () => {
  it('converts America/New_York wall time incl. DST (EDT -4h / EST -5h)', () => {
    // 2026-08-28 09:30 EDT == 13:30 UTC
    expect(easternWallTimeToEpochMs('2026-08-28 09:30')).toBe(Date.UTC(2026, 7, 28, 13, 30))
    // 2026-01-15 09:30 EST == 14:30 UTC
    expect(easternWallTimeToEpochMs('2026-01-15 09:30')).toBe(Date.UTC(2026, 0, 15, 14, 30))
  })
})

describe('StooqRestClient.getHistorical', () => {
  it('parses daily CSV rows to Kline objects (newest last) and requests the right URL', async () => {
    const { impl, urls } = stubFetch([{ match: '/q/d/l/', body: DAILY_CSV }])
    const client = new StooqRestClient({ fetchImpl: impl })
    const klines = await client.getHistorical('AAPL', '1d')

    expect(klines).toHaveLength(3)
    expect(klines[0]).toEqual({
      openTime: Date.UTC(2026, 7, 27),
      open: 225.5,
      high: 230.1,
      low: 224.8,
      close: 229.87,
      volume: 55123400,
      closeTime: Date.UTC(2026, 7, 27) + 86_400_000 - 1,
    })
    expect(klines[2]!.close).toBe(233.5)
    expect(urls[0]).toContain('https://stooq.com/q/d/l/?s=aapl.us&i=d')
  })

  it('maps intraday minutes: i=60, Eastern wall-clock openTime, closeTime = open + interval', async () => {
    const { impl, urls } = stubFetch([{ match: '/q/d/l/', body: INTRADAY_CSV }])
    const client = new StooqRestClient({ fetchImpl: impl })
    const klines = await client.getHistorical('aapl.us', '1h')

    expect(urls[0]).toContain('i=60')
    expect(klines[0]!.openTime).toBe(Date.UTC(2026, 7, 28, 13, 30))
    expect(klines[0]!.closeTime).toBe(Date.UTC(2026, 7, 28, 13, 30) + 3_600_000 - 1)
  })

  it('trims to the requested limit on the newest side (service layer contract)', async () => {
    const { impl } = stubFetch([{ match: '/q/d/l/', body: DAILY_CSV }])
    const client = new StooqRestClient({ fetchImpl: impl })
    const all = await client.getHistorical('AAPL', '1d')
    const trimmed = all.slice(-2)
    expect(trimmed.map((k) => k.close)).toEqual([232.14, 233.5])
  })

  it('rejects unsupported intervals locally (TRADING_UNSUPPORTED_INTERVAL)', async () => {
    const { impl, urls } = stubFetch([])
    const client = new StooqRestClient({ fetchImpl: impl })
    await expect(client.getHistorical('AAPL', '3m')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    await expect(client.getHistorical('AAPL', '2h')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    expect(urls).toHaveLength(0)
    expect(INTERVAL_VOCABULARY).toEqual(['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'])
  })

  it('maps the anti-bot challenge page to TRADING_RATE_LIMITED without solving it', async () => {
    const challenge = '<noscript>This site requires JavaScript to verify your browser.</noscript><script>fetch("/__verify")</script>'
    const { impl, urls } = stubFetch([{ match: '/q/d/l/', body: challenge }])
    const client = new StooqRestClient({ fetchImpl: impl })
    await expect(client.getHistorical('AAPL', '1d')).rejects.toMatchObject({ code: 'TRADING_RATE_LIMITED' })
    expect(urls).toHaveLength(1) // 不重试、不解挑战
  })

  it('maps "Access denied" / "Odmowa dostępu" to TRADING_AUTH_FAILED', async () => {
    const { impl } = stubFetch([{ match: '/q/d/l/', body: 'Access denied' }])
    const client = new StooqRestClient({ fetchImpl: impl })
    await expect(client.getHistorical('AAPL', '1d')).rejects.toMatchObject({
      code: 'TRADING_AUTH_FAILED',
      message: expect.stringContaining('stooq.com terms'),
    })
  })

  it('maps HTTP 404 (dead /q/l/ style responses) to TRADING_EXCHANGE_ERROR', async () => {
    const { impl } = stubFetch([{ match: '/q/d/l/', body: '<html>not found</html>', status: 404 }])
    const client = new StooqRestClient({ fetchImpl: impl })
    const err = await client.getHistorical('AAPL', '1d').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TradingServiceError)
    expect((err as TradingServiceError).code).toBe('TRADING_EXCHANGE_ERROR')
  })

  it('maps unknown symbols (no data rows) to TRADING_UNSUPPORTED_SYMBOL', async () => {
    const { impl } = stubFetch([{ match: '/q/d/l/', body: 'Date,Open,High,Low,Close,Volume' }])
    const client = new StooqRestClient({ fetchImpl: impl })
    await expect(client.getHistorical('ZZZZZZ', '1d')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })

  it('rejects empty symbols before any network call', async () => {
    const { impl, urls } = stubFetch([])
    const client = new StooqRestClient({ fetchImpl: impl })
    await expect(client.getHistorical('  ', '1d')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(urls).toHaveLength(0)
  })
})

describe('StooqRestClient.getTicker', () => {
  it('returns the latest daily close as snapshot (documented degradation: /q/l/ is 404)', async () => {
    const { impl, urls } = stubFetch([{ match: '/q/d/l/', body: DAILY_CSV }])
    const client = new StooqRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('aapl')

    expect(ticker).toEqual({
      symbol: 'AAPL.US',
      price: 233.5,
      volume: 48770200,
      timestamp: Date.UTC(2026, 7, 31) + 86_400_000 - 1,
    })
    expect(urls).toHaveLength(1)
  })
})
