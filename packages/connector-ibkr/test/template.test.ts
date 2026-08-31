import { describe, expect, it } from 'vitest'
import {
  IbkrRestClient,
  INTERVAL_VOCABULARY,
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

describe('IbkrRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(normalizeUsSymbol('aapl')).toBe('AAPL')
    expect(normalizeUsSymbol('NVDA')).toBe('NVDA')
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('IbkrRestClient 交易接口', () => {
  it('真实拉取可用资金与净资产', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/portfolio/U123456/ledger',
        body: {
          USD: {
            cashbalance: 45000.25,
            netliquidationvalue: 120000.5,
            currency: 'USD',
          },
        },
      },
    ])
    const client = new IbkrRestClient({ fetchImpl: impl, accountId: 'U123456' })
    const bal = await client.getBalance()

    expect(urls[0]).toContain('/portfolio/U123456/ledger')
    expect(bal).toEqual({
      currency: 'USD',
      available: 45000.25,
      total: 120000.5,
    })
  })

  it('真实下单并在收到 warning 时自动确认 reply', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/iserver/account/U123456/orders',
        body: [
          {
            id: 'reply-warn-999',
            message: ['Price exceeds percentage threshold'],
          },
        ],
      },
      {
        match: '/iserver/reply/reply-warn-999',
        body: [
          {
            order_id: 'ibkr-ord-777',
            order_status: 'PreSubmitted',
          },
        ],
      },
    ])
    const client = new IbkrRestClient({ fetchImpl: impl, accountId: 'U123456' })
    const order = await client.placeOrder(undefined, {
      symbol: 'AAPL',
      side: 'buy',
      type: 'limit',
      quantity: 10,
      price: 220.0,
    })

    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/iserver/account/U123456/orders')
    expect(urls[1]).toContain('/iserver/reply/reply-warn-999')
    expect(order.id).toBe('ibkr-ord-777')
    expect(order.symbol).toBe('AAPL')
    expect(order.dryRun).toBe(false)
  })

  it('真实撤销 IBKR 订单', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/iserver/account/U123456/order/ibkr-ord-777',
        body: { msg: 'Order cancelled' },
      },
    ])
    const client = new IbkrRestClient({ fetchImpl: impl, accountId: 'U123456' })
    const res = await client.cancelOrder(undefined, 'ibkr-ord-777')

    expect(urls[0]).toContain('/iserver/account/U123456/order/ibkr-ord-777')
    expect(res).toEqual({ orderId: 'ibkr-ord-777', status: 'canceled' })
  })

  it('真实拉取美股持仓', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/portfolio/U123456/positions/0',
        body: [
          {
            ticker: 'NVDA',
            position: 50,
            avgPrice: 110.5,
            unrealizedPnl: 1500.0,
          },
        ],
      },
    ])
    const client = new IbkrRestClient({ fetchImpl: impl, accountId: 'U123456' })
    const positions = await client.getPositions()

    expect(urls[0]).toContain('/portfolio/U123456/positions/0')
    expect(positions).toHaveLength(1)
    expect(positions[0]).toEqual({
      symbol: 'NVDA',
      quantity: 50,
      entryPrice: 110.5,
      unrealizedPnl: 1500.0,
    })
  })
})
