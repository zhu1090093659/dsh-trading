/**
 * P3 验收：CCXT 面本轮显式保持现货。
 *
 * 判据（docs/roadmap/crypto-perp-and-tradfi.md P3）：`-SWAP` 入参必须显式报
 * `TRADING_UNSUPPORTED_SYMBOL`，任何路径都不得先剥后缀再打现货端点
 * （normalizeSymbol 此前正是这么做的）。fetch 为契约化注入缝。
 */
import { describe, expect, it } from 'vitest'
import { CcxtRestClient, normalizeSymbol } from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(routes: Array<{ match: string; body: unknown }>): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body)
  }) as typeof fetch
  return { impl, urls }
}

/** 任何请求都会失败的注入缝：用来证明永续入参根本没发出网络请求。 */
function forbiddenFetch(): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    throw new Error('no request expected for a perpetual symbol')
  }) as typeof fetch
  return { impl, urls }
}

describe('CcxtRestClient 永续入参拒绝', () => {
  it('用户用规范永续形请求 ticker 时得到结构化不支持且不发任何请求', async () => {
    // Given 任何请求都会失败的注入缝
    const { impl, urls } = forbiddenFetch()
    const client = new CcxtRestClient({ exchange: 'binance', fetchImpl: impl })
    // When 用户请求永续 ticker
    // Then 报 TRADING_UNSUPPORTED_SYMBOL，且没有一条请求落到现货端点
    await expect(client.getTicker('TSLAUSDT-SWAP', 'binance')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(urls).toHaveLength(0)
  })

  it('用户用永续形请求 bybit 路由的 ticker 时同样被拒而不落现货端点', async () => {
    // Given 任何请求都会失败的注入缝
    const { impl, urls } = forbiddenFetch()
    const client = new CcxtRestClient({ exchange: 'bybit', fetchImpl: impl })
    // When 用户请求 bybit 永续 ticker
    // Then 拒绝且无请求（bybit 分支不得把 -SWAP 静默打成 spot）
    await expect(client.getTicker('BTCUSDT-SWAP', 'bybit')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(urls).toHaveLength(0)
  })

  it('用户用永续形请求 K 线时得到结构化不支持且不发任何请求', async () => {
    // Given 任何请求都会失败的注入缝
    const { impl, urls } = forbiddenFetch()
    const client = new CcxtRestClient({ fetchImpl: impl })
    // When 用户请求永续 K 线
    // Then 报不支持且无请求
    await expect(client.getKlines('BTCUSDT-SWAP', '1d', 10)).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(urls).toHaveLength(0)
  })

  it('用户输入各种写法的永续形时归一化一律显式报不支持', () => {
    // Given 规范形、小写形、带分隔符形的永续入参
    // When 归一化符号
    // Then 每种写法都抛 TRADING_UNSUPPORTED_SYMBOL，而不是偷偷剥掉后缀
    for (const raw of ['BTCUSDT-SWAP', 'btc-usdt-swap', 'BTC/USDT-SWAP', ' tsla-usdt-swap ']) {
      expect(() => normalizeSymbol(raw)).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_SYMBOL' }))
    }
  })
})

describe('CcxtRestClient 现货路径零回归', () => {
  it('用户请求现货 ticker 时仍打现货端点', async () => {
    // Given 登记现货 ticker 响应
    const { impl, urls } = stubFetch([{
      match: '/api/v3/ticker/24hr',
      body: { symbol: 'BTCUSDT', lastPrice: '64000.5', volume: '35000.2', closeTime: 1725000000000 },
    }])
    // When 用户请求现货 ticker
    const ticker = await new CcxtRestClient({ fetchImpl: impl }).getTicker('BTCUSDT', 'binance')
    // Then 命中现货端点且解析正常
    expect(urls[0]).toContain('api.binance.com/api/v3/ticker/24hr')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT', price: 64000.5, volume: 35000.2 })
  })

  it('用户请求 bybit 现货 ticker 时仍打 category=spot', async () => {
    // Given 登记 bybit 现货 ticker 响应
    const { impl, urls } = stubFetch([{
      match: '/v5/market/tickers?category=spot&symbol=ETHUSDT',
      body: { retCode: 0, result: { list: [{ symbol: 'ETHUSDT', lastPrice: '2500.25', volume24h: '1000.5' }] } },
    }])
    // When 用户请求 bybit 现货 ticker
    const ticker = await new CcxtRestClient({ exchange: 'bybit', fetchImpl: impl }).getTicker('ETHUSDT', 'bybit')
    // Then 命中现货端点
    expect(urls[0]).toContain('category=spot')
    expect(ticker).toMatchObject({ symbol: 'ETHUSDT', price: 2500.25 })
  })
})
