/**
 * P3 验收：Bybit 合约行情的形态分流。
 *
 * 判据（docs/roadmap/crypto-perp-and-tradfi.md P3）：`-SWAP` 一律打
 * `category=linear`，任何路径都不得落到 `category=spot`；输出 symbol 为规范形；
 * 名册输出 form/contract，assetClass 因交易所元数据缺项留空。
 * fetch 为契约化注入缝（未登记的路径直接失败，把「多发一条现货请求」变成红）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BybitMarketDataService } from '../src/index.js'
import { BybitRestClient, parseCryptoSymbol } from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 严格路由 fake：路径片段匹配，未登记请求抛错。 */
function strictFetch(routes: Array<{ match: string; body: unknown }>): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const target = new URL(url).pathname + new URL(url).search
    const route = routes.find((r) => target.includes(r.match))
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body)
  }) as typeof fetch
  return { impl, urls }
}

function makeServiceCtx(): Context {
  return { get: () => undefined, reflect: { provide: () => {} } } as unknown as Context
}

function service(fetchImpl: typeof fetch): BybitMarketDataService {
  return new BybitMarketDataService(makeServiceCtx(), { baseUrl: 'https://bybit.test', fetchImpl }, 'test-key')
}

const LINEAR_TICKER = {
  retCode: 0,
  retMsg: 'OK',
  result: { list: [{ symbol: 'BTCUSDT', lastPrice: '77630.00', volume24h: '69107.2280', time: 1791000000000 }] },
}
const SPOT_TICKER = {
  retCode: 0,
  retMsg: 'OK',
  result: { list: [{ symbol: 'BTCUSDT', lastPrice: '77500.00', volume24h: '15000.5000', time: 1791000000000 }] },
}

describe('BybitRestClient 形态裁决', () => {
  it('用户输入混合大小写与分隔符的永续形时裁决为 perp 并给出规范形', () => {
    // Given 入参可能是规范形、原生形或带分隔符的混排形
    // When 解析符号
    // Then 形态与规范形由后缀唯一裁决
    expect(parseCryptoSymbol('btc-usdt-swap')).toEqual({ base: 'BTCUSDT', form: 'perp', canonical: 'BTCUSDT-SWAP' })
    expect(parseCryptoSymbol('BTC/USDT')).toEqual({ base: 'BTCUSDT', form: 'spot', canonical: 'BTCUSDT' })
    expect(parseCryptoSymbol(' btcusdt ')).toEqual({ base: 'BTCUSDT', form: 'spot', canonical: 'BTCUSDT' })
  })

  it('用户给出空符号时得到结构化参数错误而不是空标的请求', () => {
    // Given 只有空白的符号入参
    // When 解析符号
    // Then 报 TRADING_INVALID_ARGUMENT
    expect(() => parseCryptoSymbol('   ')).toThrowError(expect.objectContaining({ code: 'TRADING_INVALID_ARGUMENT' }))
  })
})

describe('BybitRestClient 永续行情', () => {
  it('用户用规范永续形取 ticker 时打到线性合约端点并保持规范形', async () => {
    // Given 只登记 category=linear 的 ticker 响应（现货端点未登记，命中即失败）
    const { impl, urls } = strictFetch([{ match: '/v5/market/tickers?category=linear&symbol=BTCUSDT', body: LINEAR_TICKER }])
    // When 用户按规范形请求永续
    const ticker = await new BybitRestClient({ baseUrl: 'https://bybit.test', fetchImpl: impl }).getTicker('BTCUSDT-SWAP')
    // Then 只发出 linear 请求，返回合约价且 symbol 为规范形
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('category=linear')
    expect(urls[0]).not.toContain('category=spot')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT-SWAP', price: 77630, volume: 69107.228 })
  })

  it('用户用现货形取 ticker 时仍打现货端点（现货语义零回归）', async () => {
    // Given 只登记 category=spot 的 ticker 响应
    const { impl, urls } = strictFetch([{ match: '/v5/market/tickers?category=spot&symbol=BTCUSDT', body: SPOT_TICKER }])
    // When 用户按现货形请求
    const ticker = await new BybitRestClient({ baseUrl: 'https://bybit.test', fetchImpl: impl }).getTicker('BTCUSDT')
    // Then 请求打 spot，输出仍是不带后缀的现货形
    expect(urls[0]).toContain('category=spot')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT', price: 77500 })
  })

  it('用户用永续形取 K 线时打到线性合约端点', async () => {
    // Given 只登记 category=linear 的 kline 响应
    const { impl, urls } = strictFetch([{
      match: '/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=2',
      body: { retCode: 0, result: { list: [['1791000000000', '77000.0', '77800.0', '76900.0', '77630.0', '42.5', '3300000.0']] } },
    }])
    // When 用户请求永续 1h K 线
    const klines = await new BybitRestClient({ baseUrl: 'https://bybit.test', fetchImpl: impl }).getKlines('BTCUSDT-SWAP', '1h', 2)
    // Then 命中 linear 且解析出合约 K 线
    expect(urls[0]).toContain('category=linear')
    expect(urls[0]).not.toContain('category=spot')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ open: 77000, high: 77800, low: 76900, close: 77630, volume: 42.5 })
  })

  it('用户请求 Bybit 没有的永续时得到结构化不支持而不是现货价', async () => {
    // Given 上游对该永续回 retCode 0 + 空列表（Bybit 查无此合约的实际形状）
    const { impl, urls } = strictFetch([{
      match: '/v5/market/tickers?category=linear&symbol=TSLAUSDT',
      body: { retCode: 0, retMsg: 'OK', result: { list: [] } },
    }])
    // When 用户请求 TSLAUSDT-SWAP
    // Then 报词汇表内的 TRADING_UNSUPPORTED_SYMBOL，且请求只落在 linear
    await expect(new BybitRestClient({ baseUrl: 'https://bybit.test', fetchImpl: impl }).getTicker('TSLAUSDT-SWAP'))
      .rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('category=linear')
    expect(urls.some((url) => url.includes('category=spot'))).toBe(false)
  })

  it('用户用永续形取盘口与分笔时同样走线性合约端点', async () => {
    // Given 只登记 category=linear 的盘口与逐笔响应
    const { impl, urls } = strictFetch([
      { match: '/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=25', body: { retCode: 0, result: { b: [['77620.0', '1.5']], a: [['77630.0', '2.0']], ts: 1791000000000 } } },
      { match: '/v5/market/recent-trade?category=linear&symbol=BTCUSDT&limit=10', body: { retCode: 0, result: { list: [{ execId: 't1', price: '77630.0', size: '0.2', side: 'Buy', time: 1791000000000 }] } } },
    ])
    const client = new BybitRestClient({ baseUrl: 'https://bybit.test', fetchImpl: impl })
    // When 用户请求永续盘口与最近成交
    const book = await client.getOrderbook('BTCUSDT-SWAP')
    const trades = await client.getRecentTrades('BTCUSDT-SWAP', 10)
    // Then 两条请求都在 linear，输出 symbol 都是规范形
    expect(urls).toHaveLength(2)
    expect(urls.every((url) => url.includes('category=linear'))).toBe(true)
    expect(book.symbol).toBe('BTCUSDT-SWAP')
    expect(trades[0]).toMatchObject({ symbol: 'BTCUSDT-SWAP', price: 77630, side: 'buy' })
  })
})

describe('BybitMarketDataService.listInstruments', () => {
  it('运营查看名册时拿到现货与线性永续的并集，只留交易中标的并透传合约元数据', async () => {
    // Given 现货与线性各返回一行交易中、一行已下线/非永续的样本
    const { impl, urls } = strictFetch([
      {
        match: '/v5/market/instruments-info?category=spot&limit=1000',
        body: {
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [
              { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading' },
              { symbol: 'OLDUSDT', baseCoin: 'OLD', quoteCoin: 'USDT', status: 'Closed' },
            ],
            nextPageCursor: '',
          },
        },
      },
      {
        match: '/v5/market/instruments-info?category=linear&limit=1000',
        body: {
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [
              {
                symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading', contractType: 'LinearPerpetual',
                settleCoin: 'USDT', contractSize: '1',
                priceFilter: { tickSize: '0.10' }, lotSizeFilter: { qtyStep: '0.001' }, leverageFilter: { maxLeverage: '100' },
              },
              { symbol: 'BTCUSD', baseCoin: 'BTC', quoteCoin: 'USD', status: 'Closed', contractType: 'LinearPerpetual' },
              { symbol: 'XRPUSDT', baseCoin: 'XRP', quoteCoin: 'USDT', status: 'Trading', contractType: 'LinearFutures' },
            ],
            nextPageCursor: '',
          },
        },
      },
    ])
    // When 运营拉取名册
    const instruments = await service(impl).listInstruments()
    // Then 并集只含交易中的现货与线性永续，且形态/合约字段来自交易所元数据
    expect(urls).toHaveLength(2)
    expect(instruments).toEqual([
      { symbol: 'BTCUSDT', form: 'spot' },
      {
        symbol: 'BTCUSDT-SWAP',
        form: 'perp',
        contract: { multiplier: 1, tickSize: 0.1, lotSize: 0.001, maxLeverage: 100, settleCcy: 'USDT' },
      },
    ])
    expect(instruments.every((row) => row.assetClass === undefined)).toBe(true)
  })

  it('运营拉取名册时按交易所游标翻页取全集', async () => {
    // Given 现货名册第一页带 nextPageCursor、第二页游标为空，线性侧为空
    // 命中是「按顺序取首个包含 match 的路由」，带游标的页必须排在前面（它是首页 URL 的超串）。
    const { impl, urls } = strictFetch([
      {
        match: '/v5/market/instruments-info?category=spot&limit=1000&cursor=cur-1',
        body: { retCode: 0, result: { list: [{ symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT', status: 'Trading' }], nextPageCursor: '' } },
      },
      {
        match: '/v5/market/instruments-info?category=spot&limit=1000',
        body: { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading' }], nextPageCursor: 'cur-1' } },
      },
      { match: '/v5/market/instruments-info?category=linear&limit=1000', body: { retCode: 0, result: { list: [], nextPageCursor: '' } } },
    ])
    // When 运营拉取名册
    const instruments = await service(impl).listInstruments()
    // Then 两页都被收齐，且第二页请求带了交易所游标
    expect(instruments.map((row) => row.symbol)).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(urls.some((url) => url.includes('cursor=cur-1'))).toBe(true)
  })

  it('运营遇到上游反复回同一游标时得到结构化错误而不是无界翻页', async () => {
    // Given 上游每页都回同一个 nextPageCursor
    const { impl } = strictFetch([
      { match: '/v5/market/instruments-info?category=linear', body: { retCode: 0, result: { list: [], nextPageCursor: 'stuck' } } },
      { match: '/v5/market/instruments-info?category=spot&limit=1000', body: { retCode: 0, result: { list: [], nextPageCursor: '' } } },
    ])
    // When 运营拉取名册
    // Then 报 TRADING_EXCHANGE_ERROR（守卫生效，不挂死）
    await expect(service(impl).listInstruments()).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })
})
