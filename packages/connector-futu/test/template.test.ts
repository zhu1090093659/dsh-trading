import { describe, expect, it } from 'vitest'
import type { TradeService } from '@dshtrading/api'
import {
  FutuRestClient,
  INTERVAL_VOCABULARY,
  TradingServiceError,
  normalizeHkSymbol,
  normalizeSymbol,
  normalizeUsSymbol,
  toFutuSecurity,
} from '../src/rest.js'
import { createPlaceOrderTool, type Config } from '../src/index.js'

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

describe('FutuRestClient 符号与周期映射', () => {
  it('港股符号归一化与 Futu 证券格式转换', () => {
    expect(normalizeHkSymbol('00700.HK')).toBe('00700.HK')
    expect(normalizeHkSymbol('700')).toBe('00700.HK')
    expect(normalizeHkSymbol('HK.00700')).toBe('00700.HK')
    expect(toFutuSecurity('00700.HK')).toBe('HK.00700')
    expect(() => normalizeHkSymbol('INVALID')).toThrowError(TradingServiceError)
  })

  it('美股符号归一化与 Futu 证券格式转换（行情面双市场）', () => {
    expect(normalizeUsSymbol('AAPL')).toBe('AAPL')
    expect(normalizeUsSymbol('us.aapl')).toBe('AAPL')
    expect(normalizeUsSymbol('US.AAPL')).toBe('AAPL')
    expect(normalizeUsSymbol('BRK.B')).toBe('BRK.B')
    expect(toFutuSecurity('AAPL')).toBe('US.AAPL')
    expect(toFutuSecurity('us.brk.b')).toBe('US.BRK.B')
    expect(() => normalizeUsSymbol('12345')).toThrowError(TradingServiceError)
  })

  it('归一分派：港股形态走港股，字母形态走美股', () => {
    expect(normalizeSymbol('700')).toBe('00700.HK')
    expect(normalizeSymbol('700.HK')).toBe('00700.HK')
    expect(normalizeSymbol('aapl')).toBe('AAPL')
    expect(normalizeSymbol('us.AAPL')).toBe('AAPL')
    expect(() => normalizeSymbol('INVALID!')).toThrowError(TradingServiceError)
  })

  it('输入宽容：Futu 原生形 HK.00700 在分派与证券格式转换两侧都受理（规范词汇 §2）', () => {
    expect(normalizeSymbol('HK.00700')).toBe('00700.HK')
    expect(normalizeSymbol('hk.00700')).toBe('00700.HK')
    expect(toFutuSecurity('HK.00700')).toBe('HK.00700')
  })

  it('支持的 interval 词汇包含 5m/15m/30m/1h/1d/1w/1M', () => {
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('15m')
    expect(INTERVAL_VOCABULARY).toContain('30m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('FutuRestClient.getTicker', () => {
  it('拉取并解析港股 Ticker', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qot/get-ticker',
        body: {
          retType: 0,
          data: {
            curPrice: 380.2,
            bidPrice: 380.0,
            askPrice: 380.4,
            volume: 15000000,
            time: 1725000000000,
          },
        },
      },
    ])
    const client = new FutuRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('00700.HK')

    expect(urls[0]).toContain('security=HK.00700')
    expect(ticker).toEqual({
      symbol: '00700.HK',
      price: 380.2,
      bid: 380.0,
      ask: 380.4,
      volume: 15000000,
      timestamp: 1725000000000,
    })
  })

  it('网关连接失败时抛出包含清晰指引的 TRADING_NETWORK 错误', async () => {
    const failingFetch = (async () => {
      throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11111')
    }) as typeof fetch
    const client = new FutuRestClient({ fetchImpl: failingFetch })

    await expect(client.getTicker('00700.HK')).rejects.toMatchObject({
      code: 'TRADING_NETWORK',
    })
  })
})

describe('FutuRestClient.getKlines', () => {
  it('拉取并解析 5m/30m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qot/get-kl',
        body: {
          retType: 0,
          data: {
            klList: [
              { time: 1725000000000, open: 380.0, high: 382.0, low: 379.5, close: 381.5, volume: 50000 },
            ],
          },
        },
      },
    ])
    const client = new FutuRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('00700.HK', '5m', 10)

    expect(urls[0]).toContain('security=HK.00700')
    expect(urls[0]).toContain('klType=2') // KL_5M
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 380.0,
      high: 382.0,
      low: 379.5,
      close: 381.5,
      volume: 50000,
      closeTime: 1725000000000 + 5 * 60 * 1000 - 1,
    })
  })
})

describe('FutuRestClient 美股行情路径', () => {
  it('getTicker 接受 us.AAPL 并转换 US.AAPL，回带规范形 AAPL', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qot/get-ticker',
        body: {
          retType: 0,
          data: { curPrice: 250.5, bidPrice: 250.4, askPrice: 250.6, volume: 42000000, time: 1725000000000 },
        },
      },
    ])
    const client = new FutuRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('us.AAPL')

    expect(urls[0]).toContain('security=US.AAPL')
    expect(ticker.symbol).toBe('AAPL')
    expect(ticker.price).toBe(250.5)
  })

  it('getKlines 接受 US.AAPL 并转换 US.AAPL', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qot/get-kl',
        body: {
          retType: 0,
          data: {
            klList: [
              { time: 1725000000000, open: 248.0, high: 251.0, low: 247.5, close: 250.2, volume: 61000000 },
            ],
          },
        },
      },
    ])
    const client = new FutuRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('US.AAPL', '1d', 5)

    expect(urls[0]).toContain('security=US.AAPL')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ close: 250.2 })
  })

  it('交易面保持仅港股：US 符号下单被拒绝', async () => {
    const { impl } = stubFetch([])
    const client = new FutuRestClient({ fetchImpl: impl })
    await expect(client.placeOrder(undefined, {
      symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10,
    })).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })
})

describe('FutuRestClient.getBalance / placeOrder', () => {
  it('获取港股资产账户余额（AccountBalance 契约形状，issue #58）', async () => {
    const { impl } = stubFetch([
      { match: '/api/trd/get-funds', body: { retType: 0, data: { currency: 'HKD', cash: 200000, frozenCash: 50000, totalAssets: 500000 } } },
    ])
    const client = new FutuRestClient({ fetchImpl: impl })
    const balance = await client.getBalance()
    expect(balance).toEqual({
      asset: 'HKD',
      free: 200000,
      locked: 50000,
    })
  })

  it('港股下单并返回 Order（小写 side/type + dryRun:false 回带，issue #58）', async () => {
    const { impl, urls } = stubFetch([
      { match: '/api/trd/place-order', body: { retType: 0, data: { orderId: 'futu-ord-999' } } },
    ])
    const client = new FutuRestClient({ fetchImpl: impl })
    const order = await client.placeOrder(undefined, {
      symbol: '00700.HK',
      side: 'BUY',
      type: 'LIMIT',
      quantity: 100,
      price: 380,
    })
    expect(urls[0]).toContain('security=HK.00700')
    expect(urls[0]).toContain('qty=100')
    expect(order).toMatchObject({
      id: 'futu-ord-999',
      symbol: '00700.HK',
      side: 'buy',
      type: 'limit',
      quantity: 100,
      price: 380,
      dryRun: false,
    })
  })
})

describe('hk_place_order 工具 live 路径（issue #58）', () => {
  const config = {
    enabled: true,
    gatewayUrl: 'http://127.0.0.1:11111',
    dryRun: false,
    liveTrading: true,
    unlockPwdRef: 'FUTU_UNLOCK_PWD',
  } as Config

  it('过 live 闸门后以 OrderRequest 契约调服务：小写 side/type + dryRun:false', async () => {
    const calls: Array<Record<string, unknown>> = []
    const trade = {
      placeOrder: async (order: Record<string, unknown>) => {
        calls.push(order)
        return { id: 'live-hk-1', dryRun: false, status: 'new', ...order }
      },
    } as unknown as TradeService
    const tool = createPlaceOrderTool({
      marketData: { getTicker: async () => { throw new Error('live 路径不得查询参照价') } },
      trade,
      config,
    })
    const out = JSON.parse(String(await tool.execute({
      symbol: '00700.HK', side: 'SELL', type: 'LIMIT', quantity: 100, price: 380, dryRun: false,
    }))) as { id: string; dryRun: boolean }
    expect(out.id).toBe('live-hk-1')
    expect(out.dryRun).toBe(false)
    expect(calls[0]).toMatchObject({
      symbol: '00700.HK',
      side: 'sell',
      type: 'limit',
      quantity: 100,
      price: 380,
      dryRun: false,
    })
  })
})

