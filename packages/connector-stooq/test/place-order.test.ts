import { describe, expect, it, vi } from 'vitest'
import type { Ticker } from '@dsh-trading/api'
import { createPlaceOrderTool, evaluateOrderGate } from '../src/index.js'

const TICKER: Ticker = {
  symbol: 'AAPL.US',
  price: 233.5,
  volume: 48770200,
  timestamp: Date.UTC(2026, 7, 31) + 86_400_000 - 1,
}

type GateConfig = { dryRun: boolean; liveTrading: boolean }

function makeTool(configOverrides: Partial<GateConfig> = {}) {
  const config: GateConfig = { dryRun: true, liveTrading: false, ...configOverrides }
  const getTicker = vi.fn(async () => TICKER)
  const tool = createPlaceOrderTool({ marketData: { getTicker }, config })
  return { tool, getTicker, config }
}

const MARKET_ARGS = { symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10 }

describe('evaluateOrderGate（三条闸门路径，铁律 #3 修订版 [S4]）', () => {
  it('① dryRun=false + liveTrading=false → 结构化拒绝', () => {
    const verdict = evaluateOrderGate({ dryRun: true, liveTrading: false }, { ...MARKET_ARGS, dryRun: false })
    expect(verdict).toMatchObject({
      action: 'reject',
      code: 'TRADING_LIVE_TRADING_DISABLED',
    })
    if (verdict.action === 'reject') {
      expect(verdict.message).toContain('liveTrading=false')
    }
  })

  it('② dryRun=true（显式或缺省）→ simulate；config.dryRun 强制亦然', () => {
    expect(evaluateOrderGate({ dryRun: true, liveTrading: false }, MARKET_ARGS)).toEqual({ action: 'simulate' })
    expect(evaluateOrderGate({ dryRun: true, liveTrading: false }, { ...MARKET_ARGS, dryRun: true })).toEqual({
      action: 'simulate',
    })
    // liveTrading=true 但 config.dryRun=true：仍强制模拟（不进 ③）。
    expect(evaluateOrderGate({ dryRun: true, liveTrading: true }, { ...MARKET_ARGS, dryRun: false })).toEqual({
      action: 'simulate',
    })
  })

  it('③ dryRun=false + liveTrading=true → live（未实现错误路径）', () => {
    expect(evaluateOrderGate({ dryRun: false, liveTrading: true }, { ...MARKET_ARGS, dryRun: false })).toEqual({
      action: 'live',
    })
  })
})

describe('us_place_order execute', () => {
  it('闸门 ①：实盘请求被结构化拒绝且不抛异常、不触发行情服务', async () => {
    const { tool, getTicker } = makeTool({ liveTrading: false })
    const result = await tool.execute({ ...MARKET_ARGS, dryRun: false })
    const parsed = JSON.parse(result) as { status: string; code: string; message: string }
    expect(parsed.status).toBe('rejected')
    expect(parsed.code).toBe('TRADING_LIVE_TRADING_DISABLED')
    expect(parsed.message).toContain('dryRun=false')
    expect(getTicker).not.toHaveBeenCalled()
  })

  it('闸门 ②（缺省 dryRun）：DRY-RUN 模拟成交回执 + Stooq 收盘参照', async () => {
    const { tool, getTicker } = makeTool({ dryRun: true, liveTrading: false })
    const result = await tool.execute(MARKET_ARGS) // 不传 dryRun = 缺省模拟
    const parsed = JSON.parse(result) as {
      status: string
      dryRun: boolean
      note: string
      symbol: string
      side: string
      quantity: number
      reference: { source: string; price?: number }
    }
    expect(parsed.status).toBe('filled')
    expect(parsed.dryRun).toBe(true)
    expect(parsed.note).toContain('DRY-RUN')
    expect(parsed.symbol).toBe('AAPL.US') // 入参 AAPL → 内部规范化
    expect(parsed.reference.source).toBe('stooq-daily-close')
    expect(parsed.reference.price).toBe(233.5)
    expect(getTicker).toHaveBeenCalledWith('aapl.us')
  })

  it('闸门 ②（参照行情失败）：模拟不失败，unavailable 如实标注', async () => {
    const config: GateConfig = { dryRun: true, liveTrading: false }
    const tool = createPlaceOrderTool({
      marketData: { getTicker: async () => { throw new Error('upstream denied') } },
      config,
    })
    const result = await tool.execute(MARKET_ARGS)
    const parsed = JSON.parse(result) as { status: string; dryRun: boolean; reference: { unavailable?: string } }
    expect(parsed.status).toBe('filled')
    expect(parsed.dryRun).toBe(true)
    expect(parsed.reference.unavailable).toContain('upstream denied')
  })

  it('闸门 ③：liveTrading=true + dryRun=false → TRADING_NOT_IMPLEMENTED（Stooq 无交易 API）', async () => {
    const { tool } = makeTool({ dryRun: false, liveTrading: true })
    await expect(tool.execute({ ...MARKET_ARGS, dryRun: false })).rejects.toMatchObject({
      code: 'TRADING_NOT_IMPLEMENTED',
    })
  })

  it('参数校验：非法 side/quantity/LIMIT 缺价在触达服务前抛普通 Error', async () => {
    const { tool, getTicker } = makeTool()
    // side 的枚举校验发生在 dsh-tools schema 层（先于 execute），错误文案由 schema 生成。
    await expect(tool.execute({ ...MARKET_ARGS, side: 'LONG' })).rejects.toThrow(/side/)
    await expect(tool.execute({ ...MARKET_ARGS, quantity: 0 })).rejects.toThrow(/invalid quantity/)
    await expect(tool.execute({ ...MARKET_ARGS, type: 'LIMIT' })).rejects.toThrow(/LIMIT orders require/)
    await expect(tool.execute({ ...MARKET_ARGS, symbol: 'A B C!' })).rejects.toThrow(/invalid symbol/)
    expect(getTicker).not.toHaveBeenCalled()
  })
})
