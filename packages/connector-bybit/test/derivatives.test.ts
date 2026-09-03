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


/** issue #54：tickers 同行扩展字段 + 历史序列聚合。 */
describe('BybitMarketDataService 衍生品扩展（issue #54）', () => {
  it('tickers 行携带 nextFundingTime/markPrice/indexPrice → 进快照（基差卡底料）', async () => {
    const { impl } = stubFetch({
      '/v5/market/tickers': {
        body: {
          retCode: 0,
          result: {
            list: [{
              symbol: 'BTCUSDT', fundingRate: '0.0001', openInterest: '79500.3',
              openInterestValue: '3340000000', nextFundingTime: '1700028800000',
              markPrice: '42001.5', indexPrice: '42000.1',
            }],
          },
        },
      },
      '/v5/market/account-ratio': {
        body: { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', buyRatio: '0.55', sellRatio: '0.45' }] } },
      },
    })
    const data = await service(impl).getDerivatives('BTCUSDT')
    expect(data.nextFundingTime).toBe(1700028800000)
    expect(data.markPrice).toBe(42001.5)
    expect(data.indexPrice).toBe(42000.1)
  })

  it('getDerivativesHistory：费率历史 + OI 历史反转为时间升序', async () => {
    const { impl } = stubFetch({
      '/v5/market/funding/history': {
        body: {
          retCode: 0,
          result: {
            list: [
              { symbol: 'BTCUSDT', fundingRate: '0.0002', fundingRateTimestamp: '1700000002000' },
              { symbol: 'BTCUSDT', fundingRate: '0.0001', fundingRateTimestamp: '1700000000000' },
            ],
          },
        },
      },
      '/v5/market/open-interest': {
        body: {
          retCode: 0,
          result: {
            list: [
              { openInterest: '80100.5', timestamp: '1700000001000' },
              { openInterest: '79500.3', timestamp: '1699999000000' },
            ],
          },
        },
      },
    })
    const history = await service(impl).getDerivativesHistory('BTCUSDT')
    expect(history.symbol).toBe('BTCUSDT-SWAP')
    expect(history.fundingRates?.map(p => p.time)).toEqual([1700000000000, 1700000002000])
    expect(history.fundingRates?.map(p => p.value)).toEqual([0.0001, 0.0002])
    expect(history.openInterest?.map(p => p.value)).toEqual([79500.3, 80100.5])
  })

  it('getDerivativesHistory：单端点失败 → 该序列缺省；全失败 → 结构化错误', async () => {
    const partial = stubFetch({
      '/v5/market/funding/history': { status: 500, body: { retCode: 10001, retMsg: 'error' } },
      '/v5/market/open-interest': {
        body: { retCode: 0, result: { list: [{ openInterest: '79500.3', timestamp: '1699999000000' }] } },
      },
    })
    const history = await service(partial.impl).getDerivativesHistory('BTCUSDT')
    expect(history.fundingRates).toBeUndefined()
    expect(history.openInterest).toHaveLength(1)

    const down = stubFetch({
      '/v5/market/funding/history': { status: 500, body: { retCode: 10001, retMsg: 'error' } },
      '/v5/market/open-interest': { status: 500, body: { retCode: 10001, retMsg: 'error' } },
    })
    await expect(service(down.impl).getDerivativesHistory('BTCUSDT'))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })
})


/** issue #54 评审修复回归：M2 规范 SWAP 入参剥 -SWAP 后缀。 */
describe('BybitMarketDataService 评审修复回归（issue #54 review）', () => {
  it('规范 SWAP 形输入（BTCUSDT-SWAP）→ 请求按 BTCUSDT 发出，快照与历史同纪律', async () => {
    const { impl, urls } = stubFetch(FULL_ROUTES)
    const data = await service(impl).getDerivatives('BTCUSDT-SWAP')
    expect(data.symbol).toBe('BTCUSDT-SWAP')
    expect(urls.every(url => url.includes('symbol=BTCUSDT&') || url.includes('symbol=BTCUSDT'))).toBe(true)
    expect(urls.some(url => url.includes('BTCUSDTSWAP'))).toBe(false)

    const hist = stubFetch({
      '/v5/market/funding/history': {
        body: { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', fundingRate: '0.0001', fundingRateTimestamp: '1700000000000' }] } },
      },
      '/v5/market/open-interest': { status: 500, body: { retCode: 10001, retMsg: 'error' } },
    })
    const history = await service(hist.impl).getDerivativesHistory('BTCUSDT-SWAP')
    expect(history.symbol).toBe('BTCUSDT-SWAP')
    expect(hist.urls.every(url => !url.includes('BTCUSDTSWAP'))).toBe(true)
  })
})
