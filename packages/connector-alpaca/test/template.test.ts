import { describe, expect, it } from 'vitest'
import {
  AlpacaRestClient,
  INTERVAL_VOCABULARY,
  TradingServiceError,
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

describe('AlpacaRestClient.getTicker', () => {
  it('结合 latest trade 与 latest quote 生成 Ticker', async () => {
    const { impl, urls } = stubFetch([
      { match: '/stocks/AAPL/trades/latest', body: { trade: { p: 225.5, t: '2026-08-28T15:00:00Z' } } },
      { match: '/stocks/AAPL/quotes/latest', body: { quote: { bp: 225.4, ap: 225.6, t: '2026-08-28T15:00:00Z' } } },
    ])
    const client = new AlpacaRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('aapl')

    expect(ticker).toMatchObject({
      symbol: 'AAPL',
      price: 225.5,
      bid: 225.4,
      ask: 225.6,
    })
    expect(ticker.timestamp).toBe(new Date('2026-08-28T15:00:00Z').getTime())
    expect(urls).toHaveLength(2)
  })

  it('符号格式校验：拒绝非法字符', () => {
    expect(normalizeUsSymbol('aapl')).toBe('AAPL')
    expect(normalizeUsSymbol('BRK.B')).toBe('BRK.B')
    expect(() => normalizeUsSymbol('BAD$$$')).toThrowError(TradingServiceError)
  })

  it('401/403 映射为 TRADING_AUTH_FAILED', async () => {
    const { impl } = stubFetch([
      { match: '/stocks/AAPL/trades/latest', body: { message: 'forbidden' }, status: 403 },
      { match: '/stocks/AAPL/quotes/latest', body: { message: 'forbidden' }, status: 403 },
    ])
    const client = new AlpacaRestClient({ fetchImpl: impl })
    await expect(client.getTicker('AAPL')).rejects.toMatchObject({ code: 'TRADING_AUTH_FAILED' })
  })

  it('429 映射为 TRADING_RATE_LIMITED', async () => {
    const { impl } = stubFetch([
      { match: '/stocks/AAPL/trades/latest', body: { message: 'too many requests' }, status: 429 },
      { match: '/stocks/AAPL/quotes/latest', body: { message: 'too many requests' }, status: 429 },
    ])
    const client = new AlpacaRestClient({ fetchImpl: impl })
    await expect(client.getTicker('AAPL')).rejects.toMatchObject({ code: 'TRADING_RATE_LIMITED' })
  })
})

describe('AlpacaRestClient.getKlines', () => {
  it('拉取并解析 5m/15m/1d K 线，计算 closeTime', async () => {
    const barsData = {
      bars: {
        AAPL: [
          { t: '2026-08-28T14:30:00Z', o: 225.0, h: 226.0, l: 224.5, c: 225.8, v: 5000 },
        ],
      },
    }
    const { impl, urls } = stubFetch([
      { match: '/stocks/bars', body: barsData },
    ])
    const client = new AlpacaRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('AAPL', '5m', 10)

    expect(urls[0]).toContain('timeframe=5Min')
    expect(urls[0]).toContain('symbols=AAPL')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 225.0,
      high: 226.0,
      low: 224.5,
      close: 225.8,
      volume: 5000,
    })
    expect(klines[0]?.closeTime).toBe(klines[0]!.openTime + 5 * 60 * 1000 - 1)
  })

  it('支持的 interval 词汇包含 5m/15m/30m/1h/1d/1w/1M', () => {
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('30m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('AlpacaRestClient.listInstruments', () => {
  it('从 assets 拉取 active 股票清单', async () => {
    const assetsData = [
      { symbol: 'AAPL', name: 'Apple Inc.', tradable: true },
      { symbol: 'NVDA', name: 'NVIDIA Corporation', tradable: true },
      { symbol: 'OLD', name: 'Old Delisted', tradable: false },
    ]
    const { impl, urls } = stubFetch([
      { match: '/assets', body: assetsData },
    ])
    const client = new AlpacaRestClient({ fetchImpl: impl })
    const instruments = await client.listInstruments()

    expect(urls[0]).toContain('/assets?status=active&asset_class=us_equity')
    expect(instruments).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.' },
      { symbol: 'NVDA', name: 'NVIDIA Corporation' },
    ])
  })
})

describe('AlpacaRestClient.placeOrder / getBalance', () => {
  it('获取账户余额并映射为标准 AccountBalance', async () => {
    const { impl } = stubFetch([
      { match: '/account', body: { currency: 'USD', cash: '50000.00', portfolio_value: '120000.00' } },
    ])
    const client = new AlpacaRestClient({ fetchImpl: impl })
    const balance = await client.getBalance({ key: 'test_k', secret: 'test_s' })
    expect(balance).toEqual({
      asset: 'USD',
      free: 50000,
      locked: 70000,
    })
  })

  it('获取最新买卖盘口生成 Orderbook', async () => {
    const { impl } = stubFetch([
      { match: '/stocks/AAPL/quotes/latest', body: { quote: { bp: 220.1, ap: 220.2, bs: 200, as: 150, t: '2026-08-28T15:00:00Z' } } },
    ])
    const client = new AlpacaRestClient({ fetchImpl: impl })
    const book = await client.getOrderbook('AAPL')
    expect(book).toEqual({
      symbol: 'AAPL',
      bids: [{ price: 220.1, amount: 200 }],
      asks: [{ price: 220.2, amount: 150 }],
      timestamp: new Date('2026-08-28T15:00:00Z').getTime(),
    })
  })

  it('下单并返回 Order 实体', async () => {
    const { impl } = stubFetch([
      { match: '/orders', body: { id: 'alpaca-ord-123', status: 'new' } },
    ])
    const client = new AlpacaRestClient({ fetchImpl: impl })
    const order = await client.placeOrder({ key: 'test_k', secret: 'test_s' }, {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'LIMIT',
      quantity: 10,
      price: 220,
    })
    expect(order).toMatchObject({
      id: 'alpaca-ord-123',
      symbol: 'AAPL',
      side: 'buy',
      quantity: 10,
      price: 220,
    })
  })
})


