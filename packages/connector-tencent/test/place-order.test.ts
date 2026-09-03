import { describe, expect, it } from 'vitest'
import type { Ticker } from '@dshtrading/api'
import { type Config, type PlaceOrderArgs, buildDryRunReceipt, createPlaceOrderTool, evaluateOrderGate } from '../src/index.js'

const TICKER: Ticker = {
  symbol: 'sh600519',
  price: 1297.4,
  volume: 1_612_600,
  timestamp: Date.UTC(2026, 7, 28, 8, 15, 0),
}

function config(overrides: Partial<Config> = {}): Config {
  return { market: 'cn', dryRun: true, liveTrading: false, ...overrides }
}

function args(overrides: Partial<PlaceOrderArgs> = {}): PlaceOrderArgs {
  return { symbol: '600519', side: 'BUY', type: 'MARKET', quantity: 100, ...overrides }
}

describe('evaluateOrderGate (三路径语义，与 crypto/us 同构)', () => {
  it('dryRun 缺省/true → simulate（即使 liveTrading=false）', () => {
    expect(evaluateOrderGate(config(), args())).toEqual({ action: 'simulate' })
    expect(evaluateOrderGate(config(), args({ dryRun: true }))).toEqual({ action: 'simulate' })
    expect(evaluateOrderGate(config({ dryRun: false }), args())).toEqual({ action: 'simulate' })
  })

  it('dryRun=false 且 liveTrading=false → 结构化拒绝（headless 唯一防线）', () => {
    const verdict = evaluateOrderGate(config(), args({ dryRun: false }))
    expect(verdict.action).toBe('reject')
    expect(verdict).toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
  })

  it('dryRun=false 且 liveTrading=true 且插件 dryRun 关闭 → live（审批交给 base 闸门 ask）', () => {
    // 插件级 dryRun=true 会把一切强制为模拟（与 crypto/stooq 同语义）：live 路径要求两处开关都开。
    expect(evaluateOrderGate(config({ liveTrading: true, dryRun: false }), args({ dryRun: false }))).toEqual({ action: 'live' })
    expect(evaluateOrderGate(config({ liveTrading: true }), args({ dryRun: false }))).toEqual({ action: 'simulate' })
  })
})

describe('buildDryRunReceipt', () => {
  it('returns a marked simulated fill with a quote reference', async () => {
    const receipt = JSON.parse(await buildDryRunReceipt('cn', args({ type: 'LIMIT', price: 1290 }), { getTicker: async () => TICKER }))
    expect(receipt).toMatchObject({
      status: 'filled',
      dryRun: true,
      market: 'cn',
      symbol: 'sh600519',
      side: 'buy',
      type: 'limit',
      quantity: 100,
      price: 1290,
    })
    expect(receipt.reference).toMatchObject({ source: 'tencent-quote', price: 1297.4 })
  })

  it('keeps the simulation alive when the reference quote fails', async () => {
    const receipt = JSON.parse(
      await buildDryRunReceipt('hk', args({ symbol: '00700' }), {
        getTicker: async () => {
          throw new Error('boom')
        },
      }),
    )
    expect(receipt.dryRun).toBe(true)
    expect(receipt.symbol).toBe('00700')
    expect(receipt.reference).toMatchObject({ source: 'tencent-quote', unavailable: 'boom' })
  })
})

describe('cn_place_order tool (工厂直测，不经宿主)', () => {
  it('dry-run path returns a simulated receipt', async () => {
    const tool = createPlaceOrderTool({ marketData: { getTicker: async () => TICKER }, config: config() })
    const output = await tool.execute({ symbol: 'SH600519', side: 'BUY', type: 'MARKET', quantity: 100 })
    const receipt = JSON.parse(String(output))
    expect(receipt.status).toBe('filled')
    expect(receipt.dryRun).toBe(true)
  })

  it('live-disabled path returns a structured rejection, not a throw', async () => {
    const tool = createPlaceOrderTool({ marketData: { getTicker: async () => TICKER }, config: config() })
    const output = await tool.execute({ symbol: '600519', side: 'BUY', type: 'MARKET', quantity: 100, dryRun: false })
    expect(JSON.parse(String(output))).toMatchObject({ status: 'rejected', code: 'TRADING_LIVE_TRADING_DISABLED' })
  })

  it('argument validation errors: schema 层校验枚举（手册 §7-5 分层），execute 内校验符号/限价', async () => {
    const tool = createPlaceOrderTool({ marketData: { getTicker: async () => TICKER }, config: config() })
    await expect(tool.execute({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 100 })).rejects.toThrow(/invalid symbol/)
    // side/type 非法值在 dsh-tools schema 层即抛，到不了工具内校验——断言按层归位。
    await expect(tool.execute({ symbol: '600519', side: 'HOLD', type: 'MARKET', quantity: 100 })).rejects.toThrow(/invalid arguments/)
    await expect(tool.execute({ symbol: '600519', side: 'BUY', type: 'LIMIT', quantity: 100 })).rejects.toThrow(/LIMIT orders require/)
  })
})

describe('hk_place_order tool', () => {
  it('market split: hk config mounts hk_* tools and normalizes hk codes', async () => {
    const tool = createPlaceOrderTool({ marketData: { getTicker: async () => TICKER }, config: config({ market: 'hk' }) })
    expect(tool.name).toBe('hk_place_order')
    const output = await tool.execute({ symbol: '700', side: 'SELL', type: 'MARKET', quantity: 100 })
    expect(JSON.parse(String(output))).toMatchObject({ status: 'filled', dryRun: true, market: 'hk', symbol: '00700' })
  })

  it('live path (liveTrading=true, dryRun=false) is TRADING_NOT_IMPLEMENTED — Tencent has no trading API', async () => {
    const tool = createPlaceOrderTool({
      marketData: { getTicker: async () => TICKER },
      config: config({ market: 'hk', liveTrading: true, dryRun: false }),
    })
    await expect(tool.execute({ symbol: '00700', side: 'BUY', type: 'MARKET', quantity: 100, dryRun: false }))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })
})
