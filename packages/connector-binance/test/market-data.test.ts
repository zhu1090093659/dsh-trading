import { describe, expect, it } from 'vitest'
import {
  BinanceRestClient,
  INTERVAL_VOCABULARY,
  TradingServiceError,
} from '../src/rest.js'

const BOOK_BODY = { symbol: 'BTCUSDT', bidPrice: '42000.10', bidQty: '1.2', askPrice: '42000.30', askQty: '0.8' }
const DAY_BODY = {
  symbol: 'BTCUSDT',
  lastPrice: '42000.50',
  volume: '1234.5678',
  closeTime: 1735689600000,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 返回按 path 分发的 fetch 桩，并记录全部请求 URL。 */
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

describe('BinanceRestClient.getTicker', () => {
  it('merges 24hr ticker with bookTicker bid/ask', async () => {
    const { impl, urls } = stubFetch([
      { match: '/api/v3/ticker/24hr', body: DAY_BODY },
      { match: '/api/v3/ticker/bookTicker', body: BOOK_BODY },
    ])
    const client = new BinanceRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('btcusdt')

    expect(ticker).toMatchObject({
      symbol: 'BTCUSDT',
      price: 42000.5,
      bid: 42000.1,
      ask: 42000.3,
      volume: 1234.5678,
    })
    expect(ticker.timestamp).toBeGreaterThan(0)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/api/v3/ticker/24hr?symbol=BTCUSDT')
    expect(urls[1]).toContain('/api/v3/ticker/bookTicker?symbol=BTCUSDT')
  })

  it('maps Binance -1121 to TRADING_UNSUPPORTED_SYMBOL', async () => {
    const { impl } = stubFetch([
      { match: '/api/v3/ticker/24hr', body: { code: -1121, msg: 'Invalid symbol.' }, status: 400 },
      { match: '/api/v3/ticker/bookTicker', body: { code: -1121, msg: 'Invalid symbol.' }, status: 400 },
    ])
    const client = new BinanceRestClient({ fetchImpl: impl })
    await expect(client.getTicker('NOPE')).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_SYMBOL',
      message: expect.stringContaining('Invalid symbol.'),
    })
  })

  it('maps HTTP 429 to TRADING_RATE_LIMITED', async () => {
    const { impl } = stubFetch([
      { match: '/api/v3/ticker/24hr', body: { code: -1003, msg: 'Too much request weight.' }, status: 429 },
      { match: '/api/v3/ticker/bookTicker', body: { code: -1003, msg: 'Too much request weight.' }, status: 429 },
    ])
    const client = new BinanceRestClient({ fetchImpl: impl })
    await expect(client.getTicker('BTCUSDT')).rejects.toMatchObject({ code: 'TRADING_RATE_LIMITED' })
  })

  it('maps HTTP 5xx to TRADING_EXCHANGE_ERROR', async () => {
    const { impl } = stubFetch([
      { match: '/api/v3/ticker/24hr', body: { msg: 'boom' }, status: 500 },
      { match: '/api/v3/ticker/bookTicker', body: { msg: 'boom' }, status: 500 },
    ])
    const client = new BinanceRestClient({ fetchImpl: impl })
    const err = await client.getTicker('BTCUSDT').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TradingServiceError)
    expect((err as TradingServiceError).code).toBe('TRADING_EXCHANGE_ERROR')
  })

  it('rejects empty symbols before any network call', async () => {
    const { impl, urls } = stubFetch([])
    const client = new BinanceRestClient({ fetchImpl: impl })
    await expect(client.getTicker('  ')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(urls).toHaveLength(0)
  })
})

describe('BinanceRestClient.getKlines', () => {
  const ROW = [1735680000000, '42000', '42100', '41900', '42050', '12.5', 1735683599999, 'x', 1, 'x', 'x', '0']

  it('maps raw rows to Kline objects and passes interval/limit', async () => {
    const { impl, urls } = stubFetch([{ match: '/api/v3/klines', body: [ROW] }])
    const client = new BinanceRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('BTCUSDT', '1h', 3)

    expect(klines).toEqual([
      {
        openTime: 1735680000000,
        open: 42000,
        high: 42100,
        low: 41900,
        close: 42050,
        volume: 12.5,
        closeTime: 1735683599999,
      },
    ])
    expect(urls[0]).toContain('/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=3')
  })

  it('rejects unsupported intervals locally (TRADING_UNSUPPORTED_INTERVAL)', async () => {
    const { impl, urls } = stubFetch([])
    const client = new BinanceRestClient({ fetchImpl: impl })
    // @ts-expect-error 故意传入非法 interval
    await expect(client.getKlines('BTCUSDT', '7x')).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_INTERVAL',
    })
    expect(urls).toHaveLength(0)
    expect(INTERVAL_VOCABULARY).toContain('1M')
  })

  it('rejects out-of-range limits without a network call', async () => {
    const { impl, urls } = stubFetch([])
    const client = new BinanceRestClient({ fetchImpl: impl })
    await expect(client.getKlines('BTCUSDT', '1h', 1001)).rejects.toMatchObject({
      code: 'TRADING_EXCHANGE_ERROR',
    })
    expect(urls).toHaveLength(0)
  })
})

describe('BinanceRestClient timeout', () => {
  it('aborts slow requests and surfaces TRADING_NETWORK', async () => {
    const impl = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch
    const client = new BinanceRestClient({ fetchImpl: impl, timeoutMs: 25 })
    await expect(client.getTicker('BTCUSDT')).rejects.toMatchObject({
      code: 'TRADING_NETWORK',
      message: expect.stringContaining('timed out'),
    })
  })

  it('maps transport failures to TRADING_NETWORK', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const client = new BinanceRestClient({ fetchImpl: impl })
    await expect(client.getTicker('BTCUSDT')).rejects.toMatchObject({ code: 'TRADING_NETWORK' })
  })
})
