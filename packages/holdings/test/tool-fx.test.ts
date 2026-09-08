import { describe, expect, it } from 'vitest'
import { createMemoryHoldingsStore } from '../src/store-memory.ts'
import { registerHoldingsTools } from '../src/plugin.ts'
import { createFxGetTool } from '../src/tool.ts'
import type { FxQuote, FxService } from '../src/fx.ts'

/**
 * fx_get 工具测试（缺口卡 G7）：一律注入假 FxService，不打真实网络。
 * 覆盖：注册幂等 / 成功路径 / stale 告警 / 非法 base 抛错 / 缺省 base=USD。
 */

/** 假 FxService：记录收到的 base，返回可控 quote。 */
function fakeFx(quote: Partial<FxQuote> = {}): FxService & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async getRates(base: string): Promise<FxQuote> {
      calls.push(base)
      return {
        base: (quote.base ?? base) as FxQuote['base'],
        rates: quote.rates ?? { USD: 1, USDT: 1, CNY: 0.14, HKD: 0.128 },
        asOf: quote.asOf ?? 1_700_000_000_000,
        stale: quote.stale ?? false,
      }
    },
  }
}

/** 极简 cordis 面替身：只保留 tools 注册面与 tradingEvents 发布面。 */
function fakeContext() {
  const registered: any[] = []
  const tools = {
    register: (tool: any) => registered.push(tool),
    get: (name: string) => registered.find(tool => tool.name === name),
  }
  const ctx = {
    inject: (_deps: string[], callback: (toolCtx: unknown) => void) => callback({ tools }),
    get: (key: string) => (key === 'tradingEvents' ? { emit: () => {} } : undefined),
  }
  return { ctx, registered }
}

describe('fx_get Tool', () => {
  it('注册后存在 fx_get，重复注册幂等（不重复）', () => {
    const { ctx, registered } = fakeContext()
    registerHoldingsTools(ctx as any, { store: createMemoryHoldingsStore(), fx: fakeFx() })
    expect(registered.map(tool => tool.name)).toContain('fx_get')
    expect(registered).toHaveLength(8)

    registerHoldingsTools(ctx as any, { store: createMemoryHoldingsStore(), fx: fakeFx() })
    expect(registered).toHaveLength(8)
    expect(registered.filter(tool => tool.name === 'fx_get')).toHaveLength(1)
  })

  it('未注入 fx 时不注册 fx_get（保持既有 7 工具面）', () => {
    const { ctx, registered } = fakeContext()
    registerHoldingsTools(ctx as any, { store: createMemoryHoldingsStore() })
    expect(registered).toHaveLength(7)
    expect(registered.map(tool => tool.name)).not.toContain('fx_get')
  })

  it('注册的 fx_get 绑定注入的 FxService 实例', async () => {
    const { ctx, registered } = fakeContext()
    const fx = fakeFx()
    registerHoldingsTools(ctx as any, { store: createMemoryHoldingsStore(), fx })
    const tool = registered.find(entry => entry.name === 'fx_get')!
    const payload = JSON.parse(await tool.execute({ base: 'HKD' }))
    expect(payload.base).toBe('HKD')
    expect(fx.calls).toEqual(['HKD'])
  })

  it('成功路径：返回 ok/base/rates/asOf/stale 与口径 note', async () => {
    const tool = createFxGetTool({ fx: fakeFx() })
    const payload = JSON.parse(await (tool as any).execute({ base: 'USD' }))
    expect(payload.ok).toBe(true)
    expect(payload.base).toBe('USD')
    expect(payload.rates).toEqual({ USD: 1, USDT: 1, CNY: 0.14, HKD: 0.128 })
    expect(payload.asOf).toBe(1_700_000_000_000)
    expect(payload.stale).toBe(false)
    // stale=false 时 note 写明数据口径（rates[c] = 1 单位 c 折合多少 base）
    expect(payload.note).toContain('rates[c] = 1 单位 c 折合多少 USD')
    expect(payload.note).not.toContain('近似')
  })

  it('stale=true：note 显式告警「近似」，要求向用户标注', async () => {
    const tool = createFxGetTool({
      fx: fakeFx({ stale: true, asOf: 0, rates: { USD: 1, USDT: 1 } }),
    })
    const payload = JSON.parse(await (tool as any).execute({ base: 'USD' }))
    expect(payload.ok).toBe(true)
    expect(payload.stale).toBe(true)
    expect(payload.rates).toEqual({ USD: 1, USDT: 1 })
    expect(payload.note).toContain('近似')
    expect(payload.note).toContain('必须标注')
  })

  it('非法 base 抛错：文案含 TRADING_FX_INVALID_BASE 与合法值清单，且不打服务', async () => {
    const fx = fakeFx()
    const tool = createFxGetTool({ fx })
    await expect((tool as any).execute({ base: 'EUR' })).rejects.toThrow(/TRADING_FX_INVALID_BASE/)
    await expect((tool as any).execute({ base: 'EUR' })).rejects.toThrow(/USD \| CNY \| HKD/)
    await expect((tool as any).execute({ base: 'USDT' })).rejects.toThrow(Error)
    expect(fx.calls).toHaveLength(0)
  })

  it('缺省 base = USD；base 大小写与空白容忍', async () => {
    const fx = fakeFx()
    const tool = createFxGetTool({ fx })

    const fallback = JSON.parse(await (tool as any).execute({}))
    expect(fallback.base).toBe('USD')
    expect(fallback.ok).toBe(true)

    const lower = JSON.parse(await (tool as any).execute({ base: ' cny ' }))
    expect(lower.base).toBe('CNY')

    expect(fx.calls).toEqual(['USD', 'CNY'])
  })
})
