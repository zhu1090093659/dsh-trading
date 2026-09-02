/**
 * 衍生品快照单测（issue #38，mock fetch 不出网）：linear tickers（fundingRate/OI）
 * + account-ratio（buyRatio/sellRatio → 多空比）聚合、部分失败降级、全部失败报错。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BybitMarketDataService } from '../src/index.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeServiceCtx(): Context {
  return {
    get: () => undefined,
    reflect: { provide: () => {} },
  } as unknown as Context
}

function stubFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes[new URL(url).pathname]
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body, route.status ?? 200)
  }) as typeof fetch
  return { impl, urls }
}

const FULL_ROUTES: Record<string, { status?: number; body?: unknown }> = {
  '/v5/market/tickers': {
    body: {
      retCode: 0,
      result: { list: [{ symbol: 'BTCUSDT', fundingRate: '0.0001', openInterest: '79500.3', openInterestValue: '3340000000' }] },
    },
  },
  '/v5/market/account-ratio': {
    body: { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', buyRatio: '0.55', sellRatio: '0.45' }] } },
  },
}

function service(fetchImpl: typeof fetch): BybitMarketDataService {
  return new BybitMarketDataService(makeServiceCtx(), { baseUrl: 'https://bybit.test', fetchImpl }, 'test-key')
}

describe('BybitMarketDataService.getDerivatives', () => {
  it('聚合 linear tickers + account-ratio：多空比 = buyRatio/sellRatio，输出规范 SWAP 形', async () => {
    const { impl, urls } = stubFetch(FULL_ROUTES)
    const data = await service(impl).getDerivatives('BTCUSDT')
    expect(data).toMatchObject({
      symbol: 'BTCUSDT-SWAP',
      source: 'bybit',
      openInterest: 79500.3,
      openInterestValue: 3340000000,
      fundingRate: 0.0001,
    })
    expect(data.longShortRatio).toBeCloseTo(0.55 / 0.45, 6)
    const tickersUrl = urls.find(url => url.includes('/v5/market/tickers')) ?? ''
    expect(tickersUrl).toContain('category=linear')
  })

  it('account-ratio 失败 → 多空比降级 undefined，其余字段保留', async () => {
    const { impl } = stubFetch({
      ...FULL_ROUTES,
      '/v5/market/account-ratio': { status: 500, body: { retCode: 10001, retMsg: 'error' } },
    })
    const data = await service(impl).getDerivatives('BTCUSDT')
    expect(data.longShortRatio).toBeUndefined()
    expect(data.openInterest).toBe(79500.3)
    expect(data.fundingRate).toBe(0.0001)
  })

  it('全部端点失败 → 结构化错误（桥层转 ok:false）', async () => {
    const { impl } = stubFetch({
      '/v5/market/tickers': { status: 500, body: { retCode: 10001, retMsg: 'error' } },
      '/v5/market/account-ratio': { status: 500, body: { retCode: 10001, retMsg: 'error' } },
    })
    await expect(service(impl).getDerivatives('BTCUSDT'))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })
})
