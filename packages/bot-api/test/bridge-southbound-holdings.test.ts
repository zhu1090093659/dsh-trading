/**
 * 桥 /southbound-holdings 用例（2026-10-13 港股通持股副图，契约 C §4）：真实
 * TradingBridge + 真实 createBridgeHost（无 mock 库），市场服务按本包既有手法用
 * 契约化假件经注册表钩子注入 BridgeHost——假件只提供真服务形状，不 mock 业务行为。
 *
 * 核心判据（解析顺序冻结）：
 * - active 命中且实现 getSouthboundHoldings → 直接用 active；
 * - active 命中但方法缺失 → 按 provider 名排序扫 registry.list，取第一个实现者
 *   （本机 hk 路由 = tencent 无此能力、eastmoney 已注册非 active，就是这个场景）；
 * - 谁都没有 → TRADING_NOT_IMPLEMENTED（绝不是空序列冒充「无数据」）。
 * 另加：入参 400、TTL + in-flight 去重、空 points（非港股通标的）与上游失败可区分。
 */
import { describe, expect, it } from 'vitest'
import type { MarketDataService, SouthboundHoldingHistory } from '@dshtrading/api'
import { fakeMarketService } from '@dshtrading/test-support'
import {
  BridgeProtocolError,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
  type MarketDataRegistryLike,
} from '../src/bridge.ts'

const DAY = Date.UTC(2026, 9, 9)

/** 真服务形状的假件（无 mock 库）：只覆盖被测路径，其余方法给最小可用实现。 */
const fakeService = (overrides: Partial<MarketDataService> = {}): MarketDataService => fakeMarketService({
  getTicker: async symbol => ({ symbol, price: 100, timestamp: DAY }),
  ...overrides,
})

/** 港股通持股历史假数据（口径见契约 A：date/holdRatio/holdShares/holdMarketCap）。 */
function history(symbol: string, holdRatio: number): SouthboundHoldingHistory {
  return {
    symbol,
    points: [{ date: DAY, holdRatio, holdShares: 1000, holdMarketCap: 500_000 }],
  }
}

/** 有港股通能力的服务：按给定比例回一条历史。 */
function southboundService(holdRatio: number): MarketDataService {
  return fakeService({ getSouthboundHoldings: async symbol => history(symbol, holdRatio) })
}

function makeBridge(registry: MarketDataRegistryLike): TradingBridge {
  return new TradingBridge(createBridgeHost({ registry, legacy: () => undefined }))
}

function request(bridge: TradingBridge, query: Record<string, string>) {
  return dispatchBridgeRequest(bridge, 'GET', '/southbound-holdings', new URLSearchParams(query))
}

describe('桥 /southbound-holdings（港股通持股副图，2026-10-13）', () => {
  it('运营在激活行情源具备港股通能力时直接取该源，不扫同市场其它 provider', async () => {
    // Given active(tencent) 实现 getSouthboundHoldings，list 里另有 provider 名排在更前的实现者
    const active = southboundService(11.9)
    const other = southboundService(5.5)
    const registry: MarketDataRegistryLike = {
      active: market => (market === 'hk' ? { provider: 'tencent', service: active } : undefined),
      list: market => (market === 'hk' ? [{ provider: 'eastmoney', service: other }] : []),
    }

    // When 请求 /southbound-holdings?market=hk&symbol=00700.HK
    const { status, payload } = await request(makeBridge(registry), { market: 'hk', symbol: '00700.HK' })

    // Then 用 active 的序列（11.9 而非 list 里的 5.5）：顺序冻结为 active 优先
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, southboundHoldings: history('00700.HK', 11.9) })
  })

  it('运营在激活源无该能力时按 provider 名排序取同市场第一个实现者（tencent/eastmoney 场景）', async () => {
    // Given active 命中但方法缺失（本机 hk 路由 = tencent），list 乱序给出两个实现者
    const activeNoCapability = fakeService()
    const listedMarkets: string[] = []
    const registry: MarketDataRegistryLike = {
      active: market => (market === 'hk' ? { provider: 'tencent', service: activeNoCapability } : undefined),
      list: market => {
        listedMarkets.push(market)
        return [
          { provider: 'zeta', service: southboundService(3.3) },
          { provider: 'eastmoney', service: southboundService(11.9) },
        ]
      },
    }

    // When 请求 /southbound-holdings?market=hk&symbol=00700.HK
    const { status, payload } = await request(makeBridge(registry), { market: 'hk', symbol: '00700.HK' })

    // Then 扫的是 list 的 hk 切片，取 provider 名排序第一的 eastmoney（3.3 被跳过）
    expect(listedMarkets).toEqual(['hk'])
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, southboundHoldings: history('00700.HK', 11.9) })
  })

  it('运营在注册项里首个 provider 不具备能力时继续遍历取下一个实现者', async () => {
    // Given active 缺席，list 里 a-shim 无能力、b-eastmoney 有能力
    const registry: MarketDataRegistryLike = {
      active: () => undefined,
      list: () => [
        { provider: 'a-shim', service: fakeService() },
        { provider: 'b-eastmoney', service: southboundService(7.7) },
      ],
    }

    // When 请求
    const { status, payload } = await request(makeBridge(registry), { market: 'hk', symbol: '00939.HK' })

    // Then 跳过无能力的 a-shim，取 b-eastmoney
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, southboundHoldings: history('00939.HK', 7.7) })
  })

  it('运营在任何 provider 都没实现该端点时看到 TRADING_NOT_IMPLEMENTED，而不是空序列', async () => {
    // Given active 命中但无该方法、list 里全部无该方法
    const registry: MarketDataRegistryLike = {
      active: () => ({ provider: 'tencent', service: fakeService() }),
      list: () => [
        { provider: 'eastmoney', service: fakeService() },
        { provider: 'futu', service: fakeService() },
      ],
    }

    // When / Then 报「没有数据源」（HTTP 层映射为 200 + ok:false），绝不回空序列
    await expect(request(makeBridge(registry), { market: 'hk', symbol: '00700.HK' })).rejects.toMatchObject({
      code: 'TRADING_NOT_IMPLEMENTED',
      message: 'no southbound holdings source for hk — no provider implements getSouthboundHoldings',
    })
  })

  it('运营在注册表未提供 list 方法时（旧宿主）也只认 active 能力，否则报未实现', async () => {
    // Given 注册表只有 active（list 缺席），且 active 无该方法
    const registryWithoutList: MarketDataRegistryLike = {
      active: () => ({ provider: 'tencent', service: fakeService() }),
    }

    // When / Then 依赖 list 的路径不可用 → 明确报未实现，不静默编造数据
    await expect(request(makeBridge(registryWithoutList), { market: 'hk', symbol: '00700.HK' })).rejects.toMatchObject({
      code: 'TRADING_NOT_IMPLEMENTED',
    })
  })

  it('运营用非法市场或缺 symbol 请求时拿到 400 协议错误', async () => {
    // Given 一个有能力的注册表（校验必须先于取数发生）
    const registry: MarketDataRegistryLike = {
      active: () => ({ provider: 'eastmoney', service: southboundService(11.9) }),
    }

    // When / Then 市场不在词汇表 → 400；symbol 空白 → 400
    await expect(request(makeBridge(registry), { market: 'jp', symbol: '00700.HK' })).rejects.toMatchObject({ status: 400 })
    await expect(request(makeBridge(registry), { market: 'hk', symbol: '   ' })).rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(request(makeBridge(registry), { market: 'hk' })).rejects.toMatchObject({ status: 400 })
  })

  it('运营短时间重复请求同一标的时桥只打一轮上游（5 分钟 TTL + in-flight 去重）', async () => {
    // Given 计数上游调用次数的服务
    let calls = 0
    const counting = fakeService({
      getSouthboundHoldings: async symbol => {
        calls += 1
        return history(symbol, 11.9)
      },
    })
    const bridge = makeBridge({ active: () => ({ provider: 'eastmoney', service: counting }) })

    // When 并发两发 + 随后再来一发（同 market/symbol）
    const [first, second] = await Promise.all([
      request(bridge, { market: 'hk', symbol: '00700.HK' }),
      request(bridge, { market: 'hk', symbol: '00700.HK' }),
    ])
    const third = await request(bridge, { market: 'hk', symbol: '00700.HK' })

    // Then 三发同形，上游只被打一次
    expect(first.payload).toEqual(second.payload)
    expect(third.payload).toEqual(first.payload)
    expect(calls).toBe(1)
  })

  it('运营看到非港股通标的时如实拿到空序列（空 ≠ 0，前端据空隐藏副图）', async () => {
    // Given 服务对港股通范围外标的回空序列（契约 A 降级语义）
    const emptyService = fakeService({ getSouthboundHoldings: async symbol => ({ symbol, points: [] }) })

    // When 请求
    const { status, payload } = await request(
      makeBridge({ active: () => ({ provider: 'eastmoney', service: emptyService }) }),
      { market: 'hk', symbol: '08083.HK' },
    )

    // Then 200 + ok:true + 空 points（与「无实现」的未实现错误可区分）
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, southboundHoldings: { symbol: '08083.HK', points: [] } })
  })

  it('运营看到上游失败时错误原样上报（桥不吞成空序列）', async () => {
    // Given 服务内部抛上游错误
    const failing = fakeService({
      getSouthboundHoldings: async () => {
        throw Object.assign(new Error('eastmoney datacenter: HTTP 502'), { code: 'TRADING_UPSTREAM_ERROR' })
      },
    })

    // When / Then 桥不改写成败，交给 HTTP 层按错误词汇下发（前端隐藏副图）
    await expect(request(makeBridge({ active: () => ({ provider: 'eastmoney', service: failing }) }), {
      market: 'hk',
      symbol: '00700.HK',
    })).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
  })
})
