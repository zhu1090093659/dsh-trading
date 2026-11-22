/**
 * 桥 /etf-rescue 用例（2026-11-22 「ETF 托底」副图）：真实 TradingBridge + 真实
 * createBridgeHost（无 mock 库），市场服务按本包既有手法用契约化假件经注册表钩子
 * 注入 BridgeHost——假件只提供真服务形状，不 mock 业务行为。
 *
 * 与 southboundHoldings 同族的解析顺序（active 优先 → 同市场注册项按 provider 名排序
 * 取第一个实现者），失败面按冻结契约区分三档：
 * - 非 cn 市场 → ok:false（宽基 ETF 渗透率只有 A 股口径，连服务都不解析）；
 * - cn 但没有任何 provider 实现 getEtfRescue → 内联 ok:false + TRADING_NOT_IMPLEMENTED
 *   （能力缺席不抛到 HTTP 层）；
 * - 上游失败 → 原样抛，交 HTTP 层错误信封。
 * 另加：空 points 透传（空 ≠ 0）、TTL + in-flight 去重、缺参 400 协议错误。
 */
import { describe, expect, it } from 'vitest'
import type { EtfRescueHistory, MarketDataService } from '@dshtrading/api'
import { fakeMarketService } from '@dshtrading/test-support'
import {
  BridgeProtocolError,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
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

/** 有 ETF 托底能力的服务：按给定深度回一条历史。 */
function etfRescueService(depthPct: number): MarketDataService {
  return fakeService({ getEtfRescue: async symbol => history(symbol, depthPct) })
}

function makeBridge(registry: MarketDataRegistryLike): TradingBridge {
  return new TradingBridge(createBridgeHost({ registry, legacy: () => undefined }))
}

function request(bridge: TradingBridge, query: Record<string, string>) {
  return dispatchBridgeRequest(bridge, 'GET', '/etf-rescue', new URLSearchParams(query))
}

describe('桥 /etf-rescue（ETF 托底副图，2026-11-22）', () => {
  it('运营在激活行情源具备 ETF 托底能力时直接取该源并透传两条序列字段', async () => {
    // Given active(eastmoney) 实现 getEtfRescue
    const registry: MarketDataRegistryLike = {
      active: market => (market === 'cn' ? { provider: 'eastmoney', service: etfRescueService(0.83) } : undefined),
      list: () => [],
    }

    // When 请求 /etf-rescue?market=cn&symbol=000300
    const { status, payload } = await request(makeBridge(registry), { market: 'cn', symbol: '000300' })

    // Then 200 + ok:true，信封字段名是 etfRescue，indexCode/depthLabel/points 逐字透传
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, etfRescue: history('000300', 0.83) })
  })

  it('运营在激活源无该能力时按 provider 名排序取同市场第一个实现者', async () => {
    // Given active 命中但方法缺失，list 乱序给出两个实现者
    const registry: MarketDataRegistryLike = {
      active: market => (market === 'cn' ? { provider: 'tencent', service: fakeService() } : undefined),
      list: () => [
        { provider: 'zeta', service: etfRescueService(0.41) },
        { provider: 'akshare', service: etfRescueService(0.83) },
      ],
    }

    // When / Then 取 provider 名排序第一的 akshare（zeta 的 0.41 被跳过）
    const { payload } = await request(makeBridge(registry), { market: 'cn', symbol: '000300' })
    expect(payload).toEqual({ ok: true, etfRescue: history('000300', 0.83) })
  })

  it('运营在任何 provider 都没实现该端点时看到内联 ok:false，而不是抛异常或空序列', async () => {
    // Given active 命中但无该方法、list 里全部无该方法
    const registry: MarketDataRegistryLike = {
      active: () => ({ provider: 'tencent', service: fakeService() }),
      list: () => [
        { provider: 'eastmoney', service: fakeService() },
        { provider: 'futu', service: fakeService() },
      ],
    }

    // When 请求（不 catch：能力缺席必须由桥直接落成 ok:false 信封）
    const { status, payload } = await request(makeBridge(registry), { market: 'cn', symbol: '000300' })

    // Then 200 + ok:false + 可读文案（文案点名缺席的能力，便于用户判断装哪个连接器）
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: false, code: 'TRADING_NOT_IMPLEMENTED' })
    expect((payload as { message: string }).message).toContain('getEtfRescue')
  })

  it('运营在注册表未提供 list 方法时（旧宿主）只认 active 能力，缺席同样回 ok:false', async () => {
    // Given 注册表只有 active（list 缺席），且 active 无该方法
    const registry: MarketDataRegistryLike = {
      active: () => ({ provider: 'tencent', service: fakeService() }),
    }

    // When / Then 不静默编造数据，也不抛到外层
    const { payload } = await request(makeBridge(registry), { market: 'cn', symbol: '000300' })
    expect(payload).toMatchObject({ ok: false, code: 'TRADING_NOT_IMPLEMENTED' })
  })

  it('运营在非 A 股市场请求时不解析任何服务，直接回 ok:false', async () => {
    // Given 一个 cn 上有能力的服务（若被解析就会答出数据）
    let calls = 0
    const counting = fakeService({
      getEtfRescue: async symbol => {
        calls += 1
        return history(symbol, 0.83)
      },
    })
    const registry: MarketDataRegistryLike = {
      active: () => ({ provider: 'eastmoney', service: counting }),
      list: () => [{ provider: 'eastmoney', service: counting }],
    }

    // When 分别请求 us / hk
    const us = await request(makeBridge(registry), { market: 'us', symbol: 'AAPL' })
    const hk = await request(makeBridge(registry), { market: 'hk', symbol: '00700.HK' })

    // Then 两个市场都是 ok:false，且上游一次都没被打
    expect(us.payload).toMatchObject({ ok: false, code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(hk.payload).toMatchObject({ ok: false, code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(calls).toBe(0)
  })

  it('运营看到不映射宽基指数的标的时如实拿到空 points（空 ≠ 0，前端据空隐藏副图）', async () => {
    // Given 服务对映射不到的标的回空序列（契约：空串 indexCode + 空 points）
    const emptyService = fakeService({
      getEtfRescue: async symbol => ({ symbol, indexCode: '', depthLabel: '', points: [] }),
    })

    // When 请求一个非宽基标的
    const { status, payload } = await request(
      makeBridge({ active: () => ({ provider: 'eastmoney', service: emptyService }) }),
      { market: 'cn', symbol: '600519.SH' },
    )

    // Then 200 + ok:true + 空 points（与「无实现」的 ok:false 可区分）
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, etfRescue: { symbol: '600519.SH', indexCode: '', depthLabel: '', points: [] } })
  })

  it('运营用非法市场或缺 symbol 请求时拿到 400 协议错误', async () => {
    // Given 一个有能力的注册表（参数校验必须先于取数发生）
    const registry: MarketDataRegistryLike = {
      active: () => ({ provider: 'eastmoney', service: etfRescueService(0.83) }),
    }

    // When / Then 市场不在词汇表 → 400；symbol 空白/缺省 → 400
    await expect(request(makeBridge(registry), { market: 'jp', symbol: '000300' })).rejects.toMatchObject({ status: 400 })
    await expect(request(makeBridge(registry), { market: 'cn', symbol: '   ' })).rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(request(makeBridge(registry), { market: 'cn' })).rejects.toMatchObject({ status: 400 })
  })

  it('运营短时间重复请求同一标的时桥只打一轮上游（5 分钟 TTL + in-flight 去重）', async () => {
    // Given 计数上游调用次数的服务
    let calls = 0
    const counting = fakeService({
      getEtfRescue: async symbol => {
        calls += 1
        return history(symbol, 0.83)
      },
    })
    const bridge = makeBridge({ active: () => ({ provider: 'eastmoney', service: counting }) })

    // When 并发两发 + 随后再来一发（同 market/symbol）
    const [first, second] = await Promise.all([
      request(bridge, { market: 'cn', symbol: '000300' }),
      request(bridge, { market: 'cn', symbol: '000300' }),
    ])
    const third = await request(bridge, { market: 'cn', symbol: '000300' })

    // Then 三发同形，上游只被打一次
    expect(first.payload).toEqual(second.payload)
    expect(third.payload).toEqual(first.payload)
    expect(calls).toBe(1)
  })

  it('运营看到上游失败时错误原样上报（桥不吞成空序列或 ok:false）', async () => {
    // Given 服务内部抛上游错误
    const failing = fakeService({
      getEtfRescue: async () => {
        throw Object.assign(new Error('akshare ETF 份额: HTTP 502'), { code: 'TRADING_UPSTREAM_ERROR' })
      },
    })

    // When / Then 桥不改写成败，交给 HTTP 层按错误词汇下发（客户端看到 ok:false 并隐藏副图）
    await expect(request(makeBridge({ active: () => ({ provider: 'eastmoney', service: failing }) }), {
      market: 'cn',
      symbol: '000300',
    })).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
  })
})
