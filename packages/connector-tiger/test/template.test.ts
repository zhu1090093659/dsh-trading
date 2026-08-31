import * as crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  generateTigerSignature,
  INTERVAL_VOCABULARY,
  TigerRestClient,
  toTigerSymbol,
} from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const urls: string[] = []
  const requests: Array<{ url: string; body?: unknown }> = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body, route.status)
  }) as typeof fetch
  return { impl, urls, requests }
}

// 生成测试用 RSA 密钥对
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

describe('TigerRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(toTigerSymbol('00700')).toEqual({ symbol: '00700', canonical: '00700.HK', secType: 'STK' })
    expect(toTigerSymbol('00700.HK')).toEqual({ symbol: '00700', canonical: '00700.HK', secType: 'STK' })
    expect(toTigerSymbol('AAPL')).toEqual({ symbol: 'AAPL', canonical: 'AAPL', secType: 'STK' })
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('TigerOpen RSA-SHA256 签名算法', () => {
  it('正确生成并可被对应公钥验签', () => {
    const params = {
      tiger_id: 'test-tiger-123',
      method: 'trade_order',
      timestamp: '2026-08-31 10:00:00',
      biz_content: JSON.stringify({ symbol: '00700', action: 'BUY' }),
    }
    const signature = generateTigerSignature(params, privateKey)
    expect(signature).toBeTruthy()

    // 验证签名
    const sortedKeys = Object.keys(params).sort()
    const content = sortedKeys.map((k) => `${k}=${(params as Record<string, string>)[k]}`).join('&')
    const verify = crypto.createVerify('RSA-SHA256')
    verify.update(content, 'utf8')
    verify.end()
    const isValid = verify.verify(publicKey, signature, 'base64')
    expect(isValid).toBe(true)
  })
})

describe('TigerRestClient.getTicker', () => {
  it('拉取快照', async () => {
    const { impl } = stubFetch([
      {
        match: 'openapi.itiger.com',
        body: {
          code: 0,
          data: [
            {
              symbol: '00700',
              latestPrice: 380.2,
              volume: 15000000,
              timestamp: 1725000000000,
            },
          ],
        },
      },
    ])
    const client = new TigerRestClient({ fetchImpl: impl, tigerId: 'test-id' })
    const ticker = await client.getTicker('00700.HK')

    expect(ticker.symbol).toBe('00700.HK')
    expect(ticker.price).toBe(380.2)
  })
})

describe('TigerRestClient 交易接口', () => {
  it('真实拉取账户可用资金与净资产', async () => {
    const { impl, requests } = stubFetch([
      {
        match: 'openapi.itiger.com',
        body: {
          code: 0,
          data: {
            cash: 850000.0,
            netLiquidation: 1500000.0,
            currency: 'HKD',
          },
        },
      },
    ])
    const client = new TigerRestClient({
      fetchImpl: impl,
      tigerId: 'tiger-999',
      privateKey,
      accountId: 'acc-hk-888',
    })
    const bal = await client.getBalance()

    expect(requests[0].body).toMatchObject({
      tiger_id: 'tiger-999',
      method: 'user_asset',
      sign_type: 'RSA2',
    })
    expect((requests[0].body as { sign?: string }).sign).toBeTruthy()
    expect(bal).toEqual({
      currency: 'HKD',
      available: 850000.0,
      total: 1500000.0,
    })
  })

  it('真实提交港股委托订单', async () => {
    const { impl, requests } = stubFetch([
      {
        match: 'openapi.itiger.com',
        body: {
          code: 0,
          data: { id: 'tiger-ord-555' },
        },
      },
    ])
    const client = new TigerRestClient({
      fetchImpl: impl,
      tigerId: 'tiger-999',
      privateKey,
      accountId: 'acc-hk-888',
    })
    const order = await client.placeOrder(undefined, {
      symbol: '00700.HK',
      side: 'buy',
      type: 'limit',
      quantity: 100,
      price: 380.0,
    })

    expect(requests[0].body).toMatchObject({
      tiger_id: 'tiger-999',
      method: 'trade_order',
    })
    expect(order.id).toBe('tiger-ord-555')
    expect(order.symbol).toBe('00700.HK')
    expect(order.dryRun).toBe(false)
  })

  it('真实撤销港股订单', async () => {
    const { impl, requests } = stubFetch([
      {
        match: 'openapi.itiger.com',
        body: { code: 0, message: 'success' },
      },
    ])
    const client = new TigerRestClient({
      fetchImpl: impl,
      tigerId: 'tiger-999',
      privateKey,
      accountId: 'acc-hk-888',
    })
    const res = await client.cancelOrder(undefined, 'tiger-ord-555')
    expect(requests[0].body).toMatchObject({
      method: 'cancel_order',
    })
    expect(res).toEqual({ orderId: 'tiger-ord-555', status: 'canceled' })
  })

  it('无 privateKey 时发起交易抛出 TRADING_AUTH_FAILED', async () => {
    const client = new TigerRestClient({ tigerId: 'demo' })
    await expect(client.getBalance()).rejects.toThrowError(/privateKey.*is required/)
  })
})
