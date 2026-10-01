import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetAuthorityCache } from '@dshtrading/authority'
import { installTestAuthority, type TestAuthority } from '@dshtrading/authority/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Ticker } from '@dshtrading/api'
import { createPlaceOrderTool, evaluateOrderGate } from '../src/index.js'
import { TradingServiceError } from '../src/rest.js'

/** 实盘授权夹具：连接器闸门现在要求人工签署授权（@dshtrading/authority），
 *  用例在临时目录里搭一份真实签名的平面并指向它——不这样做，闸门 ③ 只能被 mock 掉。 */
let testAuthority: TestAuthority | undefined
beforeAll(() => { testAuthority = installTestAuthority() })
afterAll(() => { testAuthority?.uninstall() })

const TICKER: Ticker = {
  symbol: 'BTCUSDT',
  price: 42000.5,
  bid: 42000.1,
  ask: 42000.3,
  volume: 1234.5,
  timestamp: 1735689600000,
}

type GateConfig = { enabled: boolean; dryRun: boolean; liveTrading: boolean }

function makeTool(configOverrides: Partial<GateConfig> = {}) {
  const config: GateConfig = { enabled: true, dryRun: true, liveTrading: false, ...configOverrides }
  const getTicker = vi.fn(async () => TICKER)
  const tool = createPlaceOrderTool({ marketData: { getTicker }, config })
  return { tool, getTicker, config }
}

const MARKET_ARGS = { symbol: 'btcusdt', side: 'BUY', type: 'MARKET', quantity: 0.01 }

describe('evaluateOrderGate（三条闸门路径，铁律 #3 修订版 [S4]）', () => {
  it('① dryRun=false + 未获实盘授权 → 结构化拒绝', () => {
    const verdict = evaluateOrderGate({ enabled: true, dryRun: true, liveTrading: false }, { ...MARKET_ARGS, dryRun: false })
    expect(verdict).toMatchObject({
      action: 'reject',
      code: 'TRADING_LIVE_TRADING_DISABLED',
    })
    if (verdict.action === 'reject') {
      expect(verdict.message).toContain('no signed live-trading grant')
    }
  })

  it('管理员：preset 资产被改成 liveTrading=true 但授权平面未授予时仍然拒绝（RT-04 回归）', () => {
    // Given 一个只有信任锚、没有授权文档的空平面（等价于 agent 只改了资产文件）
    const emptyDir = mkdtempSync(join(tmpdir(), 'dsh-authority-empty-'))
    const previous = process.env.DSH_TRADING_AUTHORITY_DIR
    try {
      process.env.DSH_TRADING_AUTHORITY_DIR = emptyDir
      resetAuthorityCache()
      // When 资产里的镜像被改成 true 后请求实盘
      const verdict = evaluateOrderGate({ enabled: true, dryRun: false, liveTrading: true }, { ...MARKET_ARGS, dryRun: false })
      // Then 仍然结构化拒绝——镜像不能授予实盘，授权只能来自人工签署平面
      expect(verdict).toMatchObject({ action: 'reject', code: 'TRADING_LIVE_TRADING_DISABLED' })
    } finally {
      if (previous === undefined) delete process.env.DSH_TRADING_AUTHORITY_DIR
      else process.env.DSH_TRADING_AUTHORITY_DIR = previous
      resetAuthorityCache()
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('② dryRun=true（显式或缺省）→ simulate；config.dryRun 强制亦然', () => {
    expect(evaluateOrderGate({ enabled: true, dryRun: true, liveTrading: false }, MARKET_ARGS)).toEqual({ action: 'simulate' })
    expect(evaluateOrderGate({ enabled: true, dryRun: true, liveTrading: false }, { ...MARKET_ARGS, dryRun: true })).toEqual({
      action: 'simulate',
    })
    // liveTrading=true 但 config.dryRun=true：仍强制模拟（不进 ③）。
    expect(evaluateOrderGate({ enabled: true, dryRun: true, liveTrading: true }, { ...MARKET_ARGS, dryRun: false })).toEqual({
      action: 'simulate',
    })
  })

  it('③ dryRun=false + liveTrading=true → live（未实现错误路径）', () => {
    expect(evaluateOrderGate({ enabled: true, dryRun: false, liveTrading: true }, { ...MARKET_ARGS, dryRun: false })).toEqual({
      action: 'live',
    })
  })
})

describe('crypto_place_order execute', () => {
  it('闸门 ①：实盘请求被结构化拒绝且不抛异常、不触发行情服务', async () => {
    const { tool, getTicker } = makeTool({ liveTrading: false })
    const result = await tool.execute({ ...MARKET_ARGS, dryRun: false })
    const parsed = JSON.parse(result) as { status: string; code: string; message: string }
    expect(parsed.status).toBe('rejected')
    expect(parsed.code).toBe('TRADING_LIVE_TRADING_DISABLED')
    expect(parsed.message).toContain('dryRun=false')
    expect(getTicker).not.toHaveBeenCalled()
  })

  it('闸门 ②（缺省 dryRun）：DRY-RUN 模拟成交回执 + 当前市价参照', async () => {
    const { tool, getTicker } = makeTool({ dryRun: true, liveTrading: false })
    const result = await tool.execute(MARKET_ARGS) // 不传 dryRun = 缺省模拟
    const parsed = JSON.parse(result) as {
      status: string
      dryRun: boolean
      note: string
      symbol: string
      side: string
      type: string
      quantity: number
      reference: { source: string; price?: number }
    }
    expect(parsed.status).toBe('filled')
    expect(parsed.dryRun).toBe(true)
    expect(parsed.note).toContain('DRY-RUN')
    expect(parsed.symbol).toBe('BTCUSDT')
    expect(parsed.side).toBe('buy')
    expect(parsed.type).toBe('market')
    expect(parsed.quantity).toBe(0.01)
    expect(parsed.reference).toMatchObject({ source: 'binance-public-ticker', price: 42000.5 })
    expect(getTicker).toHaveBeenCalledTimes(1)
    expect(getTicker).toHaveBeenCalledWith('BTCUSDT')
  })

  it('闸门 ②：参照行情失败不阻断模拟，回执标注 unavailable', async () => {
    const getTicker = vi.fn(async () => {
      throw new TradingServiceError('TRADING_NETWORK', 'timed out')
    })
    const tool = createPlaceOrderTool({
      marketData: { getTicker },
      config: { dryRun: true, liveTrading: false },
    })
    const parsed = JSON.parse(await tool.execute(MARKET_ARGS)) as {
      status: string
      dryRun: boolean
      reference: { unavailable?: string }
    }
    expect(parsed.status).toBe('filled')
    expect(parsed.dryRun).toBe(true)
    expect(parsed.reference.unavailable).toContain('timed out')
  })

  it('闸门 ③：dryRun=false + liveTrading=true → TRADING_NOT_IMPLEMENTED 错误', async () => {
    const { tool, getTicker } = makeTool({ dryRun: false, liveTrading: true })
    await expect(tool.execute({ ...MARKET_ARGS, dryRun: false })).rejects.toMatchObject({
      name: 'TradingServiceError',
      code: 'TRADING_NOT_IMPLEMENTED',
      message: expect.stringContaining('not implemented in this slice'),
    })
    expect(getTicker).not.toHaveBeenCalled()
  })

  it('参数校验：LIMIT 缺 price / 非法数量 / 非法符号直接报错', async () => {
    const { tool } = makeTool()
    await expect(
      tool.execute({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01 }),
    ).rejects.toThrow(/LIMIT orders require a positive price/)
    await expect(
      tool.execute({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: -1 }),
    ).rejects.toThrow(/invalid quantity/)
    await expect(
      tool.execute({ symbol: 'nope!', side: 'BUY', type: 'MARKET', quantity: 0.01 }),
    ).rejects.toThrow(/invalid symbol/)
  })

  it('工具契约：名称与 dryRun schema 默认值（defineTool 编译后的 JSON Schema）', () => {
    const { tool } = makeTool()
    expect(tool.name).toBe('crypto_place_order')
    const schema = tool.parameters as {
      required?: string[]
      properties?: Record<string, { type?: string; enum?: string[]; default?: unknown }>
    }
    expect(schema.properties?.dryRun).toMatchObject({ type: 'boolean', default: true })
    // LIMIT 价格可选由 execute 校验，schema 层不强制（条件必填不可表达）。
    expect(schema.properties?.price).toMatchObject({ type: 'number' })
    expect(schema.properties?.side).toMatchObject({ enum: ['BUY', 'SELL'] })
    expect(schema.required).toEqual(expect.arrayContaining(['symbol', 'side', 'type', 'quantity']))
  })
})
