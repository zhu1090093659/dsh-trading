/**
 * 桥层三个读面的缓存协议用例（2026-10-15，简化提案第 3 项）。
 *
 * `symbolsCache` 换成 `TtlCache`、两份 inflight 协议收敛成 `#cachedFetch` 之后，
 * 三个读面各自的「时长/上限」是行为而不是实现细节，逐面钉住：
 * - symbols：30 分钟 TTL 内不打上游，过期后重新取数；
 * - fundamentals：同键并发只打一轮上游；失败不进缓存，下一次请求重试上游；
 * - southboundHoldings：同上（5 分钟 TTL + 同键去重 + 失败重试）。
 *
 * 真实 TradingBridge + 真实 createBridgeHost，市场服务用契约化假件（只提供真服务
 * 形状，不 mock 业务行为）；fundamentals 取 market=futures，其下钻分支不触上游。
 */
import { describe, expect, it, vi } from 'vitest'
import { fakeMarketService as fakeService } from '@dshtrading/test-support'
import { TradingBridge, createBridgeHost, type MarketDataRegistryLike } from '../src/bridge.ts'


describe('桥层三个读面的缓存协议（提案第 3 项）', () => {
  it('用户拉 symbols 名册时 30 分钟 TTL 内不打上游，过期后才重新取数', async () => {
    // Given 一个计数的名册服务与 30 分钟 TTL
    let calls = 0
    const service = fakeService({
      listInstruments: async () => {
        calls += 1
        return [{ symbol: 'BTCUSDT' }]
      },
    })
    const bridge = new TradingBridge(createBridgeHost({ legacy: () => service }))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 15, 0, 0, 0))

      // When TTL 内两次拉取，再跨过 30 分钟后第三次拉取
      await bridge.symbols('futures')
      await bridge.symbols('futures')
      // Then TTL 内只打一轮上游
      expect(calls).toBe(1)

      vi.setSystemTime(Date.UTC(2026, 9, 15, 0, 31, 0))
      const expired = await bridge.symbols('futures')
      // And 过期后重新取数（过期条目被丢弃，不返回旧值）
      expect(calls).toBe(2)
      expect(expired.symbols).toEqual([{ symbol: 'BTCUSDT', form: 'spot' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('用户翻 tab 取同一标的基本面时同键并发只打一轮上游，失败不进缓存', async () => {
    // Given 一个计数的基本面服务：正常符号给快照，失败符号直接抛
    const calls = new Map<string, number>()
    const service = fakeService({
      getFundamentals: async (symbol: string) => {
        calls.set(symbol, (calls.get(symbol) ?? 0) + 1)
        if (symbol === 'FAIL') throw new Error('upstream down')
        return { symbol, peTtm: 20, timestamp: 1 }
      },
    })
    const bridge = new TradingBridge(createBridgeHost({ legacy: () => service }))

    // When 同键并发两次 + 随后再来一次（都在 5 分钟 TTL 内）
    const [a, b] = await Promise.all([bridge.fundamentals('futures', 'OK'), bridge.fundamentals('futures', 'OK')])
    await bridge.fundamentals('futures', 'OK')

    // Then 三次调用只打一轮上游，且两次并发都拿到同一份数据
    expect(calls.get('OK')).toBe(1)
    expect(a).toEqual(b)

    // When 对会失败的键连续请求两次
    const first = await bridge.fundamentals('futures', 'FAIL').catch((error: unknown) => error)
    const second = await bridge.fundamentals('futures', 'FAIL').catch((error: unknown) => error)

    // Then 失败按 TRADING_NOT_IMPLEMENTED 业务码原样抛出且不进缓存：两次都真的重打了上游
    expect(first).toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    expect(second).toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    expect(calls.get('FAIL')).toBe(2)
  })

  it('用户切换副图级别反复取港股通持股时同键并发只打一轮上游，失败不进缓存', async () => {
    // Given 一个计数的港股通服务（active 命中即用），失败符号直接抛
    const calls = new Map<string, number>()
    const service = fakeService({
      getSouthboundHoldings: async (symbol: string) => {
        calls.set(symbol, (calls.get(symbol) ?? 0) + 1)
        if (symbol === 'FAIL.HK') throw new Error('southbound upstream down')
        return { symbol, points: [{ date: 1, holdRatio: 11.9, holdShares: 1000, holdMarketCap: 500_000 }] }
      },
    })
    const registry: MarketDataRegistryLike = {
      active: market => (market === 'hk' ? { provider: 'tencent', service } : undefined),
      list: () => [],
    }
    const bridge = new TradingBridge(createBridgeHost({ registry, legacy: () => undefined }))

    // When 同键并发两次 + 随后再来一次
    const [a, b] = await Promise.all([
      bridge.southboundHoldings('hk', '00700.HK'),
      bridge.southboundHoldings('hk', '00700.HK'),
    ])
    await bridge.southboundHoldings('hk', '00700.HK')

    // Then 三次调用只打一轮上游（5 分钟 TTL + 同键去重）
    expect(calls.get('00700.HK')).toBe(1)
    expect(a).toEqual(b)

    // When 对会失败的键连续请求两次
    const first = await bridge.southboundHoldings('hk', 'FAIL.HK').catch((error: unknown) => String(error))
    const second = await bridge.southboundHoldings('hk', 'FAIL.HK').catch((error: unknown) => String(error))

    // Then 上游错误原样抛出（不伪造成空序列）且不进缓存：两次都重打上游
    expect(first).toContain('southbound upstream down')
    expect(second).toContain('southbound upstream down')
    expect(calls.get('FAIL.HK')).toBe(2)
  })
})
