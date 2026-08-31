import { describe, expect, it } from 'vitest'
import {
  generateLongbridgeSignature,
  INTERVAL_VOCABULARY,
  LongbridgeRestClient,
  toLongbridgePeriod,
  toLongbridgeSymbol,
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

describe('LongbridgeRestClient 符号与周期映射', () => {
  it('港股代码转长桥代码与规范形', () => {
    expect(toLongbridgeSymbol('700')).toEqual({ symbol: '00700.HK', canonical: '00700.HK' })
    expect(toLongbridgeSymbol('00700.HK')).toEqual({ symbol: '00700.HK', canonical: '00700.HK' })
    expect(toLongbridgeSymbol('9988')).toEqual({ symbol: '09988.HK', canonical: '09988.HK' })
  })

  it('支持的 interval 词汇与 Longbridge period 映射', () => {
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(toLongbridgePeriod('5m')).toBe('5m')
    expect(toLongbridgePeriod('1h')).toBe('60m')
    expect(toLongbridgePeriod('1d')).toBe('day')
    expect(toLongbridgePeriod('1w')).toBe('week')
  })
})

describe('LongbridgeRestClient.getTicker', () => {
  it('拉取并解析港股实时行情', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v1/quote/realtime',
        body: {
          code: 0,
          data: [
            {
              symbol: '00700.HK',
              last_done: '385.4',
              volume: '1500000',
              timestamp: 1725000000,
            },
          ],
        },
      },
    ])
    const client = new LongbridgeRestClient({ fetchImpl: impl, accessToken: 'token-xyz' })
    const ticker = await client.getTicker('00700.HK')

    expect(urls[0]).toContain('symbol=00700.HK')
    expect(ticker).toEqual({
      symbol: '00700.HK',
      price: 385.4,
      volume: 1500000,
      timestamp: 1725000000000,
    })
  })
})

describe('LongbridgeRestClient 签名算法与交易接口', () => {
  it('生成符合 LongPort 官方规范的 HMAC-SHA256 签名头', () => {
    const sig = generateLongbridgeSignature(
      'secret123',
      'POST',
      '/v1/trade/order',
      {
        authorization: 'Bearer token-abc',
        'x-api-key': 'key-123',
        'x-timestamp': '1725000000000',
      },
      '{"symbol":"00700.HK"}',
    )
    expect(sig).toMatch(/^HMAC-SHA256 SignedHeaders=authorization;x-api-key;x-timestamp, Signature=[0-9a-f]{64}$/)
  })

  it('真实拉取可用资金与总资产', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v1/asset/account',
        body: {
          code: 0,
          data: {
            list: [
              {
                total_cash: '620000.5',
                net_assets: '1350000.0',
                currency: 'HKD',
              },
            ],
          },
        },
      },
    ])
    const client = new LongbridgeRestClient({
      fetchImpl: impl,
      appKey: 'key-123',
      appSecret: 'secret-123',
      accessToken: 'token-abc',
    })
    const bal = await client.getBalance()

    expect(urls[0]).toContain('/v1/asset/account')
    expect(bal).toEqual({
      currency: 'HKD',
      available: 620000.5,
      total: 1350000.0,
    })
  })

  it('真实提交港股委托订单', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v1/trade/order',
        body: {
          code: 0,
          data: { order_id: 'lb-ord-999' },
        },
      },
    ])
    const client = new LongbridgeRestClient({
      fetchImpl: impl,
      appKey: 'key-123',
      appSecret: 'secret-123',
      accessToken: 'token-abc',
    })
    const order = await client.placeOrder(undefined, {
      symbol: '00700.HK',
      side: 'buy',
      type: 'limit',
      quantity: 100,
      price: 385.0,
    })

    expect(urls[0]).toContain('/v1/trade/order')
    expect(order.id).toBe('lb-ord-999')
    expect(order.symbol).toBe('00700.HK')
    expect(order.dryRun).toBe(false)
  })

  it('真实撤销 Longbridge 订单', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/v1/trade/order',
        body: { code: 0, message: 'success' },
      },
    ])
    const client = new LongbridgeRestClient({
      fetchImpl: impl,
      appKey: 'key-123',
      appSecret: 'secret-123',
      accessToken: 'token-abc',
    })
    const res = await client.cancelOrder(undefined, 'lb-ord-999')
    expect(urls[0]).toContain('order_id=lb-ord-999')
    expect(res).toEqual({ orderId: 'lb-ord-999', status: 'canceled' })
  })

  it('无凭证时发起交易抛出 TRADING_AUTH_FAILED', async () => {
    const client = new LongbridgeRestClient({})
    await expect(client.getBalance()).rejects.toThrowError(/appKey and accessToken are required/)
  })
})
