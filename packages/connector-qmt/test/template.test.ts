import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  QmtRestClient,
  toQmtCode,
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

describe('QmtRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(toQmtCode('600519')).toBe('600519.SH')
    expect(toQmtCode('000001')).toBe('000001.SZ')
    expect(toQmtCode('600519.SH')).toBe('600519.SH')
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('QmtRestClient 交易接口', () => {
  it('真实拉取可用资金与总资产', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/v1/trade/asset',
        body: {
          code: 0,
          data: {
            cash: 250000.5,
            total_asset: 680000.0,
            frozen_cash: 50000.0,
            currency: 'CNY',
          },
        },
      },
    ])
    const client = new QmtRestClient({ fetchImpl: impl, accountId: '12345678' })
    const bal = await client.getBalance()

    expect(urls[0]).toContain('account_id=12345678')
    expect(bal).toEqual({
      currency: 'CNY',
      available: 250000.5,
      total: 680000.0,
    })
  })

  it('真实提交 A 股委托订单', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/v1/trade/order',
        body: {
          code: 0,
          data: {
            order_id: 'qmt-ord-8888',
            status: 'new',
          },
        },
      },
    ])
    const client = new QmtRestClient({ fetchImpl: impl, accountId: '12345678' })
    const order = await client.placeOrder(undefined, {
      symbol: '600519.SH',
      side: 'buy',
      type: 'limit',
      quantity: 100,
      price: 1750.0,
    })

    expect(urls[0]).toContain('/api/v1/trade/order')
    expect(order.id).toBe('qmt-ord-8888')
    expect(order.symbol).toBe('600519.SH')
    expect(order.side).toBe('buy')
    expect(order.dryRun).toBe(false)
  })

  it('真实撤销 A 股委托订单', async () => {
    const { impl } = stubFetch([
      {
        match: '/api/v1/trade/cancel',
        body: {
          code: 0,
          data: { order_id: 'qmt-ord-8888' },
        },
      },
    ])
    const client = new QmtRestClient({ fetchImpl: impl, accountId: '12345678' })
    const res = await client.cancelOrder(undefined, 'qmt-ord-8888')
    expect(res).toEqual({ orderId: 'qmt-ord-8888', status: 'canceled' })
  })

  it('无 accountId 时抛出 TRADING_AUTH_FAILED', async () => {
    const client = new QmtRestClient({})
    await expect(client.getBalance()).rejects.toThrowError(/accountId is required/)
  })
})
