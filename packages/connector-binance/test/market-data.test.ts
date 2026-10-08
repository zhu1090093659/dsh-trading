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

describe('BinanceRestClient.listInstruments（现货 ∪ USDT-M 永续，2026-10-08 P2）', () => {
  const SPOT_BODY = {
    timezone: 'UTC',
    serverTime: 1735689600000,
    symbols: [
      { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' },
      { symbol: 'ETHUSDT', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDT' },
      { symbol: 'OLDCOIN', status: 'BREAK', baseAsset: 'OLD', quoteAsset: 'USDT' },
      { symbol: 'DELISTED', status: 'HALT', baseAsset: 'DELIST', quoteAsset: 'USDT' },
    ],
  }
  const FAPI_BODY = {
    timezone: 'UTC',
    serverTime: 1735689600000,
    symbols: [
      {
        symbol: 'BTCUSDT',
        status: 'TRADING',
        contractType: 'PERPETUAL',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        marginAsset: 'USDT',
        contractSize: 1,
        underlyingType: 'COIN',
        underlyingSubType: ['PoW'],
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.10' },
          { filterType: 'LOT_SIZE', stepSize: '0.001' },
        ],
      },
      { symbol: 'ETHUSDT_250926', status: 'TRADING', contractType: 'CURRENT_QUARTER', baseAsset: 'ETH', quoteAsset: 'USDT', underlyingType: 'COIN' },
      { symbol: 'HALTEDUSDT', status: 'BREAK', contractType: 'PERPETUAL', baseAsset: 'HALTED', quoteAsset: 'USDT' },
    ],
  }

  it('用户 在 Binance 名册里同时看到现货与 USDT-M 永续（形态成对 + 合约规格透传）', async () => {
    // Given: 现货与合约两侧的 exchangeInfo 样本（含非 TRADING / 非 PERPETUAL 噪音行）
    const { impl, urls } = stubFetch([
      { match: '/api/v3/exchangeInfo', body: SPOT_BODY },
      { match: '/fapi/v1/exchangeInfo', body: FAPI_BODY },
    ])
    // When: 拉取名册
    const instruments = await new BinanceRestClient({ fetchImpl: impl }).listInstruments()
    // Then: 现货保留原形、永续加 -SWAP 后缀，噪音行剔除，两半各打各的端点
    expect(urls[0]).toContain('/api/v3/exchangeInfo')
    expect(urls[1]).toContain('/fapi/v1/exchangeInfo')
    expect(instruments).toEqual([
      { symbol: 'BTCUSDT', name: 'BTC/USDT', form: 'spot', assetClass: 'crypto' },
      { symbol: 'ETHUSDT', name: 'ETH/USDT', form: 'spot', assetClass: 'crypto' },
      {
        symbol: 'BTCUSDT-SWAP',
        name: 'BTC/USDT',
        form: 'perp',
        assetClass: 'crypto',
        contract: { multiplier: 1, tickSize: 0.1, lotSize: 0.001, settleCcy: 'USDT' },
      },
    ])
  })

  it('用户 看到 Binance 合约的资产类别只由 underlying 元数据裁决（未登记即留空，不按符号猜）', async () => {
    // Given: underlyingType 已知（STOCK）、只在 underlyingSubType 出现（INDEX）、完全取不到 三类合约行
    const { impl } = stubFetch([
      { match: '/api/v3/exchangeInfo', body: { symbols: [] } },
      {
        match: '/fapi/v1/exchangeInfo',
        body: {
          symbols: [
            { symbol: 'TSLAUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'TSLA', quoteAsset: 'USDT', underlyingType: 'STOCK' },
            { symbol: 'SPXUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'SPX', quoteAsset: 'USDT', underlyingType: 'UNKNOWN', underlyingSubType: ['INDEX'] },
            { symbol: 'MYSTERYUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'MYSTERY', quoteAsset: 'USDT' },
          ],
        },
      },
    ])
    // When: 拉取名册
    const instruments = await new BinanceRestClient({ fetchImpl: impl }).listInstruments()
    // Then: 已知字段给标签，取不到留空（符号字面不参与裁决）
    expect(instruments.map((inst) => [inst.symbol, inst.assetClass])).toEqual([
      ['TSLAUSDT-SWAP', 'equity'],
      ['SPXUSDT-SWAP', 'index'],
      ['MYSTERYUSDT-SWAP', undefined],
    ])
  })

  it('用户 看到 Binance TradFi 永续（TRADIFI_PERPETUAL）与各地区股票/Pre-IPO 字面量各归其类', async () => {
    // Given: 可达环境实测的行（`contractType=TRADIFI_PERPETUAL` + EQUITY/HK_EQUITY/KR_EQUITY/CN_EQUITY/PREMARKET/FX 字面量，且响应里没有 contractSize）
    const { impl } = stubFetch([
      { match: '/api/v3/exchangeInfo', body: { symbols: [] } },
      {
        match: '/fapi/v1/exchangeInfo',
        body: {
          symbols: [
            { symbol: 'TSLAUSDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', baseAsset: 'TSLA', quoteAsset: 'USDT', marginAsset: 'USDT', underlyingType: 'EQUITY', underlyingSubType: ['TradFi'], filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000' }, { filterType: 'LOT_SIZE', stepSize: '0.01' }] },
            { symbol: 'TENCENTUSDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', baseAsset: 'TENCENT', quoteAsset: 'USDT', underlyingType: 'HK_EQUITY' },
            { symbol: 'SAMSUNGUSDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', baseAsset: 'SAMSUNG', quoteAsset: 'USDT', underlyingType: 'KR_EQUITY' },
            { symbol: 'CXMTUSDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', baseAsset: 'CXMT', quoteAsset: 'USDT', underlyingType: 'CN_EQUITY' },
            { symbol: 'OPENAIUSDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', baseAsset: 'OPENAI', quoteAsset: 'USDT', underlyingType: 'PREMARKET', underlyingSubType: ['Pre-IPO', 'TradFi'] },
            { symbol: 'USDBRLUSDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', baseAsset: 'USDBRL', quoteAsset: 'USDT', underlyingType: 'FX' },
          ],
        },
      },
    ])
    // When: 拉取名册
    const instruments = await new BinanceRestClient({ fetchImpl: impl }).listInstruments()
    // Then: TradFi 永续不再被 PERPETUAL 白名单整批漏掉；FX 无枚举成员 ⇒ 留空而不是硬塞进 equity/commodity
    expect(instruments.map((inst) => [inst.symbol, inst.assetClass])).toEqual([
      ['TSLAUSDT-SWAP', 'equity'],
      ['TENCENTUSDT-SWAP', 'equity'],
      ['SAMSUNGUSDT-SWAP', 'equity'],
      ['CXMTUSDT-SWAP', 'equity'],
      ['OPENAIUSDT-SWAP', 'equity'],
      ['USDBRLUSDT-SWAP', undefined],
    ])
    // And: 实测 USDT-M 响应没有 contractSize ⇒ 合约规格不出现 multiplier（不按猜测补 1）
    expect(instruments[0].contract).toEqual({ tickSize: 0.01, lotSize: 0.01, settleCcy: 'USDT' })
  })

  it('用户 在名册任一半失败时拿到结构化错误（不返回半份名册）', async () => {
    // Given: 现货端点不可用（地域 451），合约端点正常
    const { impl } = stubFetch([
      { match: '/api/v3/exchangeInfo', body: { code: 0, msg: 'Service unavailable from a restricted location' }, status: 451 },
      { match: '/fapi/v1/exchangeInfo', body: FAPI_BODY },
    ])
    // When: 拉取名册
    const err = await new BinanceRestClient({ fetchImpl: impl }).listInstruments().catch((e: unknown) => e)
    // Then: 结构化错误，而不是悄悄少一半的名册
    expect(err).toBeInstanceOf(TradingServiceError)
    expect((err as TradingServiceError).code).toBe('TRADING_EXCHANGE_ERROR')
  })

  it('用户 遇到交易所返回畸形名册响应时拿到结构化错误', async () => {
    // Given: 现货响应 symbols 不是数组，合约响应正常
    const { impl } = stubFetch([
      { match: '/api/v3/exchangeInfo', body: { symbols: 'not-array' } },
      { match: '/fapi/v1/exchangeInfo', body: FAPI_BODY },
    ])
    // When: 拉取名册
    const err = await new BinanceRestClient({ fetchImpl: impl }).listInstruments().catch((e: unknown) => e)
    // Then: TRADING_EXCHANGE_ERROR
    expect(err).toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })
})

describe('BinanceRestClient 形态分流（getTicker/getKlines 按 -SWAP 后缀选 base）', () => {
  const PERP_DAY = { symbol: 'BTCUSDT', lastPrice: '42000.50', volume: '800', prevClosePrice: '41000', priceChangePercent: '2.4' }
  const PERP_BOOK = { symbol: 'BTCUSDT', bidPrice: '42000.10', askPrice: '42000.30' }

  it('用户 对永续符号取报价时请求打到 fapi，且拿回规范 -SWAP 形', async () => {
    // Given: 合约侧 24hr 与 bookTicker 样本
    const { impl, urls } = stubFetch([
      { match: '/fapi/v1/ticker/24hr', body: PERP_DAY },
      { match: '/fapi/v1/ticker/bookTicker', body: PERP_BOOK },
    ])
    // When: 取 BTCUSDT-SWAP 报价
    const ticker = await new BinanceRestClient({ fetchImpl: impl }).getTicker('btcusdt-swap')
    // Then: 两个端点都在 fapi，输出符号保持规范永续形
    expect(urls).toHaveLength(2)
    expect(urls.every((url) => url.startsWith('https://fapi.binance.com/fapi/v1/ticker/'))).toBe(true)
    expect(urls[0]).toContain('/fapi/v1/ticker/24hr?symbol=BTCUSDT')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT-SWAP', price: 42000.5, bid: 42000.1, ask: 42000.3, prevClose: 41000 })
  })

  it('用户 对现货符号取报价时仍打到 /api/v3（现货路径零回归）', async () => {
    // Given: 现货侧 24hr 与 bookTicker 样本
    const { impl, urls } = stubFetch([
      { match: '/api/v3/ticker/24hr', body: PERP_DAY },
      { match: '/api/v3/ticker/bookTicker', body: PERP_BOOK },
    ])
    // When: 取 BTCUSDT 报价
    const ticker = await new BinanceRestClient({ fetchImpl: impl }).getTicker('BTCUSDT')
    // Then: 走的还是现货端点，符号不带后缀
    expect(urls[0]).toContain('/api/v3/ticker/24hr?symbol=BTCUSDT')
    expect(ticker.symbol).toBe('BTCUSDT')
  })

  it('用户 对永续符号取 K 线时打到 /fapi/v1/klines 且交易所符号剥掉 -SWAP 后缀', async () => {
    // Given: 合约 K 线样例行
    const ROW = [1735680000000, '42000', '42100', '41900', '42050', '12.5', 1735683599999]
    const { impl, urls } = stubFetch([{ match: '/fapi/v1/klines', body: [ROW] }])
    // When: 取 BTCUSDT-SWAP 日线
    const klines = await new BinanceRestClient({ fetchImpl: impl }).getKlines('BTCUSDT-SWAP', '1d', 1)
    // Then: fapi 端点 + 剥后缀的交易所符号
    expect(urls[0]).toContain('/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=1')
    expect(klines).toHaveLength(1)
    expect(klines[0]?.close).toBe(42050)
  })

  it('用户 在合约端点地域受限（HTTP 451）时拿到结构化错误，不会拿到现货报价冒充的合约价', async () => {
    // Given: fapi 451（本机实测形态），现货端点可用
    const { impl, urls } = stubFetch([
      { match: '/api/v3/ticker/24hr', body: DAY_BODY },
      { match: '/api/v3/ticker/bookTicker', body: BOOK_BODY },
      { match: '/fapi/v1/ticker/24hr', body: { code: 0, msg: 'Service unavailable from a restricted location' }, status: 451 },
      { match: '/fapi/v1/ticker/bookTicker', body: { code: 0, msg: 'Service unavailable from a restricted location' }, status: 451 },
    ])
    // When: 取 BTCUSDT-SWAP 报价
    const err = await new BinanceRestClient({ fetchImpl: impl }).getTicker('BTCUSDT-SWAP').catch((e: unknown) => e)
    // Then: 结构化错误，且没有任何请求落到现货端点
    expect((err as TradingServiceError).code).toBe('TRADING_EXCHANGE_ERROR')
    expect(urls.every((url) => url.includes('/fapi/v1/'))).toBe(true)
  })
})
