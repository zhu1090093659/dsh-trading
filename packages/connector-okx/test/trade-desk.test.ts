/**
 * 交易台只读面单测（issue #40，离线）：listOpenOrders / listTradeFills 的
 * 行映射（SWAP 张→币换算、状态映射、升序反转）与凭证缺失 fail-closed。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { OkxRestClient } from '../src/rest.js'
import { OkxTradeService, type Config } from '../src/index.js'

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeServiceCtx(): Context {
  return {
    get: () => undefined,
    reflect: { provide: () => {} },
  } as unknown as Context
}

function baseConfig(): Config {
  return {
    enabled: true,
    env: 'demo',
    dryRun: true,
    liveTrading: false,
    apiKeyRef: 'OKX_API_KEY',
    secretRef: 'OKX_SECRET_KEY',
    passphraseRef: 'OKX_PASSPHRASE',
    demoApiKeyRef: 'OKX_DEMO_API_KEY',
    demoSecretRef: 'OKX_DEMO_SECRET_KEY',
    demoPassphraseRef: 'OKX_DEMO_PASSPHRASE',
  }
}

const PENDING_BODY = {
  code: '0',
  data: [
    {
      instId: 'BTC-USDT-SWAP', ordId: 'o2', side: 'buy', ordType: 'limit',
      px: '42000.5', sz: '2', accFillSz: '1', state: 'partially_filled',
      uTime: '1700000001000', cTime: '1700000000000',
    },
    {
      instId: 'BTC-USDT', ordId: 'o1', side: 'sell', ordType: 'limit',
      px: '43000', sz: '0.5', accFillSz: '0', state: 'live',
      uTime: '1700000002000', cTime: '1700000002000',
    },
  ],
}

const FILLS_BODY = {
  code: '0',
  data: [
    { instId: 'BTC-USDT-SWAP', billId: 'f2', fillPx: '42001', fillSz: '3', side: 'sell', fee: '-0.5', feeCcy: 'USDT', ts: '1700000001000' },
    { instId: 'BTC-USDT', billId: 'f1', fillPx: '41995', fillSz: '0.1', side: 'buy', fee: '-0.01', feeCcy: 'USDT', ts: '1700000000000' },
  ],
}

/** 假凭证（签名解析离线可算，mock fetch 不校验头）；SWAP 规格走 instruments mock。 */
function service(fetchImpl: typeof fetch): OkxTradeService {
  const rest = new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, clockSync: false, clockOffsetMs: 0 })
  return new OkxTradeService(makeServiceCtx(), {
    client: rest,
    config: baseConfig(),
    getCredentials: async () => ({ key: 'k', secret: 's', passphrase: 'p' }),
  }, 'test-trade')
}

const INSTRUMENT_ROUTES: Record<string, { status?: number; body?: unknown }> = {
  '/api/v5/public/instruments': {
    body: {
      code: '0',
      data: [{ instId: 'BTC-USDT-SWAP', instType: 'SWAP', lotSz: '0.1', minSz: '0.1', tickSz: '0.1', ctVal: '0.01' }],
    },
  },
}

function routeByPath(routes: Record<string, { status?: number; body?: unknown }>) {
  return (async (input: unknown) => {
    const url = String(input)
    const route = routes[new URL(url).pathname]
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return okResponse(route.body, route.status ?? 200)
  }) as typeof fetch
}

describe('OkxTradeService.listOpenOrders/listTradeFills（issue #40）', () => {
  it('挂单映射：SWAP 张→币换算、state→status、无 instId 过滤时全量', async () => {
    const fetchImpl = routeByPath({
      ...INSTRUMENT_ROUTES,
      '/api/v5/trade/orders-pending': { body: PENDING_BODY },
    })
    const orders = await service(fetchImpl).listOpenOrders()
    expect(orders).toHaveLength(2)
    // SWAP sz=2 张 × ctVal 0.01 = 0.02 币；accFillSz=1 张 → 0.01 币。
    const swap = orders.find(order => order.id === 'o2')
    expect(swap).toMatchObject({
      symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'limit',
      status: 'partially_filled', price: 42000.5, quantity: 0.02, filledQuantity: 0.01,
    })
    const spot = orders.find(order => order.id === 'o1')
    expect(spot).toMatchObject({ symbol: 'BTCUSDT', status: 'new', quantity: 0.5 })
  })

  it('流水映射：时间升序（新→旧 反转）、SWAP fillSz 换算、fee 取绝对值', async () => {
    const fetchImpl = routeByPath({
      ...INSTRUMENT_ROUTES,
      '/api/v5/trade/fills-history': { body: FILLS_BODY },
    })
    const fills = await service(fetchImpl).listTradeFills()
    expect(fills.map(fill => fill.id)).toEqual(['f1', 'f2'])
    expect(fills[1]).toMatchObject({ symbol: 'BTCUSDT-SWAP', side: 'sell', price: 42001, amount: 0.03, fee: 0.5, feeAsset: 'USDT' })
    expect(fills[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'buy', price: 41995, amount: 0.1 })
  })

  it('凭证缺失 → fail-closed（TRADING_CREDENTIALS_MISSING），不静默返回空', async () => {
    const rest = new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl: routeByPath({}), clockSync: false, clockOffsetMs: 0 })
    // 环境无 OKX_DEMO_* → resolveCredentials 环境回退也失败。
    const trade = new OkxTradeService(makeServiceCtx(), { client: rest, config: baseConfig(), getCredentials: () => resolveFailing() }, 'test-trade')
    await expect(trade.listOpenOrders()).rejects.toMatchObject({ code: 'TRADING_CREDENTIALS_MISSING' })
    function resolveFailing(): Promise<never> {
      return Promise.reject(Object.assign(new Error('missing'), { code: 'TRADING_CREDENTIALS_MISSING' }))
    }
  })
})
