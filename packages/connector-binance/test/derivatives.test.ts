/**
 * 衍生品快照单测（issue #38，mock fetch 不出网）：fapi 公共端点聚合、
 * SWAP/现货输入归一、部分失败降级、全部失败结构化报错。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BinanceMarketDataService } from '../src/index.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeServiceCtx(): Context {
  return {
    get: () => undefined,
    reflect: { provide: () => {} },
  } as unknown as Context
}

/** 按 path 分发的 fetch 桩（记录全部请求 URL）。 */
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
  '/fapi/v1/openInterest': { body: { symbol: 'BTCUSDT', openInterest: '80000.5', time: 1700000000000 } },
  '/fapi/v1/fundingRate': { body: [{ symbol: 'BTCUSDT', fundingRate: '0.0001', fundingTime: 1700000001000 }] },
  '/futures/data/globalLongShortAccountRatio': { body: [{ symbol: 'BTCUSDT', longShortRatio: '1.1', period: '1h' }] },
  '/futures/data/topLongShortPositionRatio': { body: [{ symbol: 'BTCUSDT', longShortRatio: '1.05', period: '1h' }] },
  '/futures/data/takerlongshortRatio': { body: [{ symbol: 'BTCUSDT', buySellRatio: '1.02', period: '1h' }] },
}

function service(fetchImpl: typeof fetch): BinanceMarketDataService {
  return new BinanceMarketDataService(
    makeServiceCtx(),
    { baseUrl: 'https://binance.test', fapiBaseUrl: 'https://fapi.test', fetchImpl },
    'test-key',
  )
}

describe('BinanceMarketDataService.getDerivatives', () => {
  it('聚合五端点：fapi base + 规范 SWAP 输出 + 币数持仓', async () => {
    const { impl, urls } = stubFetch(FULL_ROUTES)
    const data = await service(impl).getDerivatives('BTCUSDT')
    expect(data).toMatchObject({
      symbol: 'BTCUSDT-SWAP',
      source: 'binance',
      openInterest: 80000.5,
      longShortRatio: 1.1,
      topTraderLongShortRatio: 1.05,
      takerBuySellRatio: 1.02,
      fundingRate: 0.0001,
      timestamp: 1700000000000,
    })
    expect(urls.every(url => url.startsWith('https://fapi.test/'))).toBe(true)
  })

  it('SWAP/OKX 原生输入归一到 fapi 词汇（BTCUSDT-SWAP / BTC-USDT-SWAP → BTCUSDT）', async () => {
    const { impl, urls } = stubFetch(FULL_ROUTES)
    await service(impl).getDerivatives('BTC-USDT-SWAP')
    const oi = urls.find(url => url.includes('/fapi/v1/openInterest')) ?? ''
    expect(oi).toContain('symbol=BTCUSDT')
  })

  it('单端点失败 → 该字段降级 undefined，其余字段保留', async () => {
    const { impl } = stubFetch({
      ...FULL_ROUTES,
      '/futures/data/topLongShortPositionRatio': { status: 500, body: { code: -1000, msg: 'internal' } },
    })
    const data = await service(impl).getDerivatives('BTCUSDT')
    expect(data.topTraderLongShortRatio).toBeUndefined()
    expect(data.longShortRatio).toBe(1.1)
    expect(data.openInterest).toBe(80000.5)
  })

  it('全部端点失败 → 结构化错误（桥层转 ok:false）', async () => {
    const down: Record<string, { status?: number; body?: unknown }> = {}
    for (const path of Object.keys(FULL_ROUTES)) {
      down[path] = { status: 500, body: { code: -1000, msg: 'internal' } }
    }
    const { impl } = stubFetch(down)
    await expect(service(impl).getDerivatives('BTCUSDT'))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })
})


/** issue #54：premiumIndex 扩展字段 + 历史序列聚合。 */
describe('BinanceMarketDataService 衍生品扩展（issue #54）', () => {
  const EXT_ROUTES: Record<string, { status?: number; body?: unknown }> = {
    ...FULL_ROUTES,
    '/fapi/v1/premiumIndex': {
      body: {
        symbol: 'BTCUSDT', markPrice: '42001.5', indexPrice: '42000.1',
        lastFundingRate: '0.0001', nextFundingTime: 1700028800000, time: 1700000002000,
      },
    },
  }

  it('premiumIndex → markPrice/indexPrice/nextFundingTime 进快照（基差卡底料）', async () => {
    const { impl } = stubFetch(EXT_ROUTES)
    const data = await service(impl).getDerivatives('BTCUSDT')
    expect(data.markPrice).toBe(42001.5)
    expect(data.indexPrice).toBe(42000.1)
    expect(data.nextFundingTime).toBe(1700028800000)
  })

  it('getDerivativesHistory：fundingRate 历史 + openInterestHist 聚合为升序点列', async () => {
    const { impl } = stubFetch({
      '/fapi/v1/fundingRate': {
        body: [
          { symbol: 'BTCUSDT', fundingRate: '0.0001', fundingTime: 1700000000000 },
          { symbol: 'BTCUSDT', fundingRate: '0.0002', fundingTime: 1700000002000 },
        ],
      },
      '/futures/data/openInterestHist': {
        body: [
          { symbol: 'BTCUSDT', sumOpenInterest: '79500.3', sumOpenInterestValue: '3340000000', timestamp: 1699999000000 },
          { symbol: 'BTCUSDT', sumOpenInterest: '80100.5', sumOpenInterestValue: '3360000000', timestamp: 1700000001000 },
        ],
      },
    })
    const history = await service(impl).getDerivativesHistory('BTCUSDT')
    expect(history.symbol).toBe('BTCUSDT-SWAP')
    expect(history.fundingRates).toEqual([
      { time: 1700000000000, value: 0.0001 },
      { time: 1700000002000, value: 0.0002 },
    ])
    expect(history.openInterest?.map(p => p.value)).toEqual([79500.3, 80100.5])
  })

  it('getDerivativesHistory：单端点失败 → 该序列缺省；全失败 → 结构化错误', async () => {
    const partial = stubFetch({
      '/fapi/v1/fundingRate': { status: 500, body: { code: -1000, msg: 'internal' } },
      '/futures/data/openInterestHist': {
        body: [{ symbol: 'BTCUSDT', sumOpenInterest: '79500.3', timestamp: 1699999000000 }],
      },
    })
    const history = await service(partial.impl).getDerivativesHistory('BTCUSDT')
    expect(history.fundingRates).toBeUndefined()
    expect(history.openInterest).toHaveLength(1)

    const down = stubFetch({
      '/fapi/v1/fundingRate': { status: 500, body: { code: -1000, msg: 'internal' } },
      '/futures/data/openInterestHist': { status: 500, body: { code: -1000, msg: 'internal' } },
    })
    await expect(service(down.impl).getDerivativesHistory('BTCUSDT'))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })
})
