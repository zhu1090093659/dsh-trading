/**
 * 桥 /etf-rescue 用例（2026-11-22 「ETF 托底」副图）：真实 TradingBridge + 真实
 * createBridgeHost（无 mock 库），取数源经 `host.fetchEtfRescue` 注入缝给契约化假件。
 *
 * **分层事实（本文件要钉住的那条）**：这个端点读的是参考数据（ETF 份额 × 净值 ÷ 指数
 * 流通市值），缺省由 `@dshtrading/kit-cn` 的 `fetchCnEtfRescue` 供给，**不经过行情路由**。
 * 早先把数据做成连接器的可选能力时，`routeAllows` 让它在 cn 未被路由到该连接器时永不
 * 注册——特性随报价源开关，是错的分层（2026-11-22 装 Mac 时实测踩中）。所以这里断言：
 * 行情注册表里哪怕有个自带同名方法实现的服务，也不参与本端点。
 *
 * 失败面：非 cn 市场 → 内联 ok:false（宽基 ETF 渗透率只有 A 股口径）；上游失败 → 原样抛，
 * 交 HTTP 层错误信封。另加：空 points 透传（空 ≠ 0）、TTL + in-flight 去重、缺参 400。
 */
import { describe, expect, it } from 'vitest'
import type { EtfRescueHistory, MarketDataService } from '@dshtrading/api'
import { fakeMarketService } from '@dshtrading/test-support'
import {
  BridgeProtocolError,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
  type EtfRescueFetcher,
  type MarketDataRegistryLike,
} from '../src/bridge.ts'

const DAY = Date.UTC(2026, 10, 20)

/** 真服务形状的假件（无 mock 库）：只覆盖被测路径，其余方法给最小可用实现。 */
const fakeService = (overrides: Partial<MarketDataService> = {}): MarketDataService => fakeMarketService({
  getTicker: async symbol => ({ symbol, price: 100, timestamp: DAY }),
  ...overrides,
})

/** 「ETF 托底」历史假数据（口径见 api 契约：date/depthPct/breadthPct）。 */
function history(symbol: string, depthPct: number, breadthPct = 1.13): EtfRescueHistory {
  return {
    symbol,
    indexCode: '000300',
    depthLabel: '沪深300ETF',
    points: [{ date: DAY, depthPct, breadthPct }],
  }
}

/** 取数缝的假实现：按给定深度回一条历史，并记录被调次数。 */
function countingFetcher(depthPct: number): { fetcher: EtfRescueFetcher, calls: () => number } {
  let calls = 0
  return {
    fetcher: async symbol => {
      calls += 1
      return history(symbol, depthPct)
    },
    calls: () => calls,
  }
}

function makeBridge(registry: MarketDataRegistryLike | undefined, fetcher?: EtfRescueFetcher): TradingBridge {
  return new TradingBridge(createBridgeHost({
    ...(registry === undefined ? {} : { registry }),
    legacy: () => undefined,
    ...(fetcher === undefined ? {} : { fetchEtfRescue: fetcher }),
  }))
}

function request(bridge: TradingBridge, query: Record<string, string>) {
  return dispatchBridgeRequest(bridge, 'GET', '/etf-rescue', new URLSearchParams(query))
}

describe('桥 /etf-rescue（ETF 托底副图，2026-11-22）', () => {
  it('运营请求已映射的宽基指数时拿到两条序列字段逐字透传', async () => {
    // Given 注入了取数缝
    const { fetcher } = countingFetcher(0.83)

    // When 请求 /etf-rescue?market=cn&symbol=000300
    const { status, payload } = await request(makeBridge(undefined, fetcher), { market: 'cn', symbol: '000300' })

    // Then 200 + ok:true，信封字段名是 etfRescue，indexCode/depthLabel/points 逐字透传
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, etfRescue: history('000300', 0.83) })
  })

  it('运营的行情源即使自带同名取数方法也不参与这个端点（不经行情路由）', async () => {
    // Given 注册表里的 cn 服务可调用、一旦被当成数据源就会炸；注入的取数缝正常
    const registry: MarketDataRegistryLike = {
      active: () => ({
        provider: 'akshare',
        service: fakeService({
          getEtfRescue: async () => {
            throw new Error('行情源不该被 /etf-rescue 调用')
          },
        } as Partial<MarketDataService>),
      }),
      list: () => [],
    }
    const { fetcher } = countingFetcher(0.83)

    // When
    const { payload } = await request(makeBridge(registry, fetcher), { market: 'cn', symbol: '000300' })

    // Then 数据来自取数缝，注册表那条路一次都没走
    expect(payload).toEqual({ ok: true, etfRescue: history('000300', 0.83) })
  })

  it('运营在非 A 股市场请求时回 ok:false，且取数缝一次都没被打', async () => {
    // Given 一个会计数的取数缝
    const { fetcher, calls } = countingFetcher(0.83)
    const bridge = makeBridge(undefined, fetcher)

    // When 分别请求 us / hk
    const us = await request(bridge, { market: 'us', symbol: 'AAPL' })
    const hk = await request(bridge, { market: 'hk', symbol: '00700.HK' })

    // Then 两个市场都是 ok:false，上游零调用
    expect(us.payload).toMatchObject({ ok: false, code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(hk.payload).toMatchObject({ ok: false, code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(calls()).toBe(0)
  })

  it('运营看到不映射宽基指数的标的时如实拿到空 points（空 ≠ 0，前端据空隐藏副图）', async () => {
    // Given 取数缝对映射不到的标的回空序列（契约：空串 indexCode + 空 points）
    const emptyFetcher: EtfRescueFetcher = async symbol => ({ symbol, indexCode: '', depthLabel: '', points: [] })

    // When 请求一个非宽基标的
    const { status, payload } = await request(makeBridge(undefined, emptyFetcher), { market: 'cn', symbol: '600519.SH' })

    // Then 200 + ok:true + 空 points
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, etfRescue: { symbol: '600519.SH', indexCode: '', depthLabel: '', points: [] } })
  })

  it('运营用非法市场或缺 symbol 请求时拿到 400 协议错误', async () => {
    // Given 一个正常取数缝（参数校验必须先于取数发生）
    const { fetcher, calls } = countingFetcher(0.83)
    const bridge = makeBridge(undefined, fetcher)

    // When / Then 市场不在词汇表 → 400；symbol 空白/缺省 → 400
    await expect(request(bridge, { market: 'jp', symbol: '000300' })).rejects.toMatchObject({ status: 400 })
    await expect(request(bridge, { market: 'cn', symbol: '   ' })).rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(request(bridge, { market: 'cn' })).rejects.toMatchObject({ status: 400 })
    expect(calls()).toBe(0)
  })

  it('运营短时间重复请求同一标的时桥只打一轮上游（5 分钟 TTL + in-flight 去重）', async () => {
    // Given 计数上游调用次数的取数缝
    const { fetcher, calls } = countingFetcher(0.83)
    const bridge = makeBridge(undefined, fetcher)

    // When 并发两发 + 随后再来一发（同 market/symbol）
    const [first, second] = await Promise.all([
      request(bridge, { market: 'cn', symbol: '000300' }),
      request(bridge, { market: 'cn', symbol: '000300' }),
    ])
    const third = await request(bridge, { market: 'cn', symbol: '000300' })

    // Then 三发同形，上游只被打一次
    expect(first.payload).toEqual(second.payload)
    expect(third.payload).toEqual(first.payload)
    expect(calls()).toBe(1)
  })

  it('运营看到上游失败时错误原样上报（桥不吞成空序列或 ok:false）', async () => {
    // Given 取数缝内部抛上游错误
    const failing: EtfRescueFetcher = async () => {
      throw Object.assign(new Error('etf 份额: HTTP 502'), { code: 'TRADING_UPSTREAM_ERROR' })
    }

    // When / Then 桥不改写成败，交给 HTTP 层按错误词汇下发
    await expect(request(makeBridge(undefined, failing), { market: 'cn', symbol: '000300' }))
      .rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
  })
})
