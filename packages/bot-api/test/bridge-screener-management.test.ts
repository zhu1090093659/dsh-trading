/**
 * 选股器管理桥路由单测（2026-09-07）：PUT/DELETE /strategies/screeners
 * （覆盖确认闸门 + vm 落盘前校验 + 墓碑语义）、POST /strategies/screeners/reset。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MarketDataService } from '@dshtrading/api'
import {
  createMemoryBuiltinTombstonesStore,
  createMemoryCustomScreenerStore,
  createMemoryCustomStrategyStore,
} from '@dshtrading/strategies'
import { TradingBridge, createBridgeHost, dispatchBridgeRequest } from '../src/bridge.ts'

vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('bridge test must not hit network')
}))

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
    screenerStore: createMemoryCustomScreenerStore(),
  })
  return { bridge: new TradingBridge(host), host }
}

const URLLike = (s: string) => new URL(s, 'http://dsh.local')

const VALID = {
  id: 'scr.custom-momentum',
  title: '动量',
  summary: 'x',
  paramsJson: '[]',
  columnsJson: JSON.stringify([{ key: 'mom', label: '动量' }]),
  evaluateSource: `(bars) => {
    if (bars.length < 2) return null
    const mom = (bars[bars.length - 1].close - bars[0].close) / bars[0].close * 100
    if (mom <= 0) return null
    return { metrics: { mom }, reason: '动量为正' }
  }`,
}

describe('选股器管理桥路由', () => {
  it('PUT 合法自定义 → 落盘并在名册可见', async () => {
    const { bridge } = makeBridge()
    const url = URLLike('/strategies/screeners')
    const { payload } = await dispatchBridgeRequest(bridge, 'PUT', '/strategies/screeners', url.searchParams, VALID)
    expect(payload).toMatchObject({ ok: true, overridesScreener: false })
    expect((await bridge.customScreeners()).screeners).toHaveLength(1)
  })

  it('PUT 内置 id 无确认位 → TRADING_SCREENER_OVERRIDE_CONFIRM；带确认位 → 覆盖', async () => {
    const { bridge } = makeBridge()
    const url = URLLike('/strategies/screeners')
    const denied = await dispatchBridgeRequest(bridge, 'PUT', '/strategies/screeners', url.searchParams, {
      ...VALID, id: 'scr.rsi-oversold',
    })
    expect(denied.payload).toMatchObject({ ok: false, code: 'TRADING_SCREENER_OVERRIDE_CONFIRM' })

    const okd = await dispatchBridgeRequest(bridge, 'PUT', '/strategies/screeners', url.searchParams, {
      ...VALID, id: 'scr.rsi-oversold', overridesScreener: true,
    })
    expect(okd.payload).toMatchObject({ ok: true, overridesScreener: true })
  })

  it('DELETE 内置 → 墓碑；reset 清除；自定义 reset → TRADING_SCREENER_NOT_BUILTIN', async () => {
    const { bridge } = makeBridge()
    const putUrl = URLLike('/strategies/screeners')
    await dispatchBridgeRequest(bridge, 'PUT', '/strategies/screeners', putUrl.searchParams, {
      ...VALID, id: 'scr.near-high', overridesScreener: true,
    })
    const delUrl = URLLike('/strategies/screeners?id=scr.near-high')
    const { payload } = await dispatchBridgeRequest(bridge, 'DELETE', '/strategies/screeners', delUrl.searchParams, undefined)
    expect(payload).toMatchObject({ ok: true, removed: true, scope: 'builtin' })
    expect((await bridge.builtinTombstones()).deleted).toEqual(['scr.near-high'])

    const resetUrl = URLLike('/strategies/screeners/reset')
    const reset = await dispatchBridgeRequest(bridge, 'POST', '/strategies/screeners/reset', resetUrl.searchParams, { id: 'scr.near-high' })
    expect(reset.payload).toMatchObject({ ok: true, changed: true })
    expect((await bridge.builtinTombstones()).deleted).toEqual([])

    const notBuiltin = await dispatchBridgeRequest(bridge, 'POST', '/strategies/screeners/reset', resetUrl.searchParams, { id: VALID.id })
    expect(notBuiltin.payload).toMatchObject({ ok: false, code: 'TRADING_SCREENER_NOT_BUILTIN' })
  })

  it('非法 evaluate → TRADING_SCREENER_INVALID', async () => {
    const { bridge } = makeBridge()
    const url = URLLike('/strategies/screeners')
    const { payload } = await dispatchBridgeRequest(bridge, 'PUT', '/strategies/screeners', url.searchParams, {
      ...VALID, evaluateSource: '(bars) => "hit"',
    })
    expect(payload).toMatchObject({ ok: false, code: 'TRADING_SCREENER_INVALID' })
  })
})
