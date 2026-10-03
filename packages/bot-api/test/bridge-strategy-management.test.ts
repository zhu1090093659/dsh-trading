/**
 * 策略管理桥路由单测（2026-09-07）：PUT /strategies/custom（覆盖确认闸门 +
 * vm 落盘前校验）、DELETE 墓碑语义、POST /strategies/reset、GET /strategies/tombstones。
 * 宿主面全部用假件（不触网）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MarketDataService } from '@dshtrading/api'
import { createMemoryBuiltinTombstonesStore, createMemoryCustomStrategyStore } from '@dshtrading/strategies'
import { TradingBridge, createBridgeHost, dispatchBridgeRequest } from '../src/bridge.ts'

vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('bridge test must not hit network')
}))

const VALID_SOURCE = `(bars) => {
  const out = []
  let long = false
  for (let i = 1; i < bars.length; i++) {
    if (!long && i % 2 === 1) { out.push({ index: i, time: bars[i].openTime, action: 'entry', direction: 'long', price: bars[i].close, reason: 'demo entry' }); long = true }
    else if (long && i % 2 === 0) { out.push({ index: i, time: bars[i].openTime, action: 'exit', direction: 'flat', price: bars[i].close, reason: 'demo exit' }); long = false }
  }
  return out
}`

function fakeService(): MarketDataService {
  return {
    getTicker: async (symbol) => ({ symbol, price: 100, timestamp: 1 }),
    getKlines: async () => [],
    subscribeTicker: () => ({ dispose() {} }),
  }
}

function makeBridge() {
  const host = createBridgeHost({
    legacy: () => fakeService(),
    strategyStore: createMemoryCustomStrategyStore(),
    tombstonesStore: createMemoryBuiltinTombstonesStore(),
  })
  return { bridge: new TradingBridge(host), host }
}

const URLLike = (s: string) => new URL(s, 'http://dsh.local')

describe('PUT /strategies/custom（策略管理保存）', () => {
  it('合法自定义策略 → 落盘并在名册可见', async () => {
    const { bridge } = makeBridge()
    const url = URLLike('/strategies/custom')
    const { status, payload } = await dispatchBridgeRequest(bridge, 'PUT', '/strategies/custom', url.searchParams, {
      id: 'demo-alternating', title: '演示', horizon: 'swing', summary: 'x',
      paramsJson: '[]', computeSource: VALID_SOURCE,
    })
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, overridesBuiltin: false })
    const roster = await bridge.customStrategies()
    expect(roster.strategies.some((s) => s.id === 'demo-alternating')).toBe(true)
  })

  it('内置 id 无确认位 → TRADING_STRATEGY_OVERRIDE_CONFIRM 业务拒绝', async () => {
    const { bridge } = makeBridge()
    const url = URLLike('/strategies/custom')
    const { payload } = await dispatchBridgeRequest(bridge, 'PUT', '/strategies/custom', url.searchParams, {
      id: 'ema-crossover', title: '覆盖', horizon: 'swing', summary: 'x',
      paramsJson: '[]', computeSource: VALID_SOURCE,
    })
    expect(payload).toMatchObject({ ok: false, code: 'TRADING_STRATEGY_OVERRIDE_CONFIRM' })
  })

  it('内置 id + overridesBuiltin:true → 覆盖落盘', async () => {
    const { bridge } = makeBridge()
    const url = URLLike('/strategies/custom')
    const { payload } = await dispatchBridgeRequest(bridge, 'PUT', '/strategies/custom', url.searchParams, {
      id: 'ema-crossover', title: '覆盖', horizon: 'swing', summary: 'x',
      paramsJson: '[]', computeSource: VALID_SOURCE, overridesBuiltin: true,
    })
    expect(payload).toMatchObject({ ok: true, overridesBuiltin: true })
    expect((await bridge.customStrategies()).strategies.some((s) => s.id === 'ema-crossover')).toBe(true)
  })

  it('非法源码 → TRADING_STRATEGY_INVALID（含人话原因）', async () => {
    const { bridge } = makeBridge()
    const url = URLLike('/strategies/custom')
    const { payload } = await dispatchBridgeRequest(bridge, 'PUT', '/strategies/custom', url.searchParams, {
      id: 'bad-strategy', title: '坏', horizon: 'swing', summary: 'x',
      paramsJson: '[]', computeSource: '(bars) => "not a signal array"',
    })
    expect(payload).toMatchObject({ ok: false, code: 'TRADING_STRATEGY_INVALID' })
  })
})

describe('DELETE /strategies/custom 墓碑语义', () => {
  it('内置 → 墓碑入表；reset 清除；自定义 → 移除', async () => {
    const { bridge } = makeBridge()
    // 先落一个内置覆盖，验证删除时被一并丢弃。
    const putUrl = URLLike('/strategies/custom')
    await dispatchBridgeRequest(bridge, 'PUT', '/strategies/custom', putUrl.searchParams, {
      id: 'ema-crossover', title: '覆盖', horizon: 'swing', summary: 'x',
      paramsJson: '[]', computeSource: VALID_SOURCE, overridesBuiltin: true,
    })

    const delUrl = URLLike('/strategies/custom?id=ema-crossover')
    const { payload } = await dispatchBridgeRequest(bridge, 'DELETE', '/strategies/custom', delUrl.searchParams, undefined)
    expect(payload).toMatchObject({ ok: true, removed: true, scope: 'builtin' })
    expect((await bridge.builtinTombstones()).deleted).toEqual(['ema-crossover'])
    expect((await bridge.customStrategies()).strategies).toHaveLength(0)

    const resetUrl = URLLike('/strategies/reset')
    const reset = await dispatchBridgeRequest(bridge, 'POST', '/strategies/reset', resetUrl.searchParams, { id: 'ema-crossover' })
    expect(reset.payload).toMatchObject({ ok: true, changed: true })
    expect((await bridge.builtinTombstones()).deleted).toEqual([])

    const notBuiltin = await dispatchBridgeRequest(bridge, 'POST', '/strategies/reset', resetUrl.searchParams, { id: 'my-own' })
    expect(notBuiltin.payload).toMatchObject({ ok: false, code: 'TRADING_STRATEGY_NOT_BUILTIN' })
  })
})

describe('GET /strategies/tombstones', () => {
  it('返回墓碑清单', async () => {
    const { bridge } = makeBridge()
    await bridge.host.tombstonesStore?.add('donchian-breakout')
    const url = URLLike('/strategies/tombstones')
    const { payload } = await dispatchBridgeRequest(bridge, 'GET', '/strategies/tombstones', url.searchParams, undefined)
    expect(payload).toEqual({ ok: true, deleted: ['donchian-breakout'] })
  })
})
