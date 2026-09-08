/**
 * strategy_backtest 参数覆盖单测（issue #86 / 缺口卡 G3，离线）：
 * paramsJson 声明键校验、clamp、params.effective 回显、非法输入拒绝。
 */
import { describe, expect, it } from 'vitest'
import type { MarketDataService } from '@dshtrading/api'
import { createMemoryCustomStrategyStore } from '../src/custom.ts'
import { createStrategyBacktestTool } from '../src/plugin.ts'

function fakeService(): MarketDataService {
  return {
    getTicker: async (symbol) => ({ symbol, price: 100, timestamp: 1 }),
    getKlines: async () => Array.from({ length: 120 }, (_, i) => ({
      openTime: 1700000000000 + i * 86_400_000,
      open: 100 + Math.sin(i / 3) * 5,
      high: 105 + Math.sin(i / 3) * 5,
      low: 95 + Math.sin(i / 3) * 5,
      close: 100 + Math.sin(i / 3) * 5,
      volume: 1000,
      closeTime: 1700000000000 + (i + 1) * 86_400_000 - 1,
    })),
    subscribeTicker: () => ({ dispose() {} }),
  } satisfies MarketDataService
}

function makeTool() {
  return createStrategyBacktestTool({
    store: createMemoryCustomStrategyStore(),
    marketData: () => fakeService(),
  })
}

type BacktestWire = {
  ok: boolean
  params: { requested: Record<string, number>; effective: Record<string, number> }
  barsTested: number
}

describe('strategy_backtest paramsJson', () => {
  it('缺省回显策略声明默认值', async () => {
    const wire = JSON.parse(String(await makeTool().execute({ strategyId: 'ema-crossover', market: 'us', symbol: 'AAPL' }))) as BacktestWire
    expect(wire.ok).toBe(true)
    expect(wire.params.requested).toEqual({})
    expect(Object.keys(wire.params.effective).length).toBeGreaterThan(0)
  })

  it('覆盖值生效并 clamp 到声明区间', async () => {
    const base = JSON.parse(String(await makeTool().execute({ strategyId: 'ema-crossover', market: 'us', symbol: 'AAPL' }))) as BacktestWire
    const key = Object.keys(base.params.effective)[0]
    expect(key).toBeDefined()
    const overridden = JSON.parse(String(await makeTool().execute({
      strategyId: 'ema-crossover', market: 'us', symbol: 'AAPL', paramsJson: JSON.stringify({ [key as string]: 99999 }),
    }))) as BacktestWire
    expect(overridden.params.requested[key as string]).toBe(99999)
    // clamp 到 max（不是 99999），且与默认值不同——证明覆盖真的进了引擎。
    expect(overridden.params.effective[key as string]).not.toBe(99999)
    expect(overridden.params.effective[key as string]).not.toBe(base.params.effective[key as string])
  })

  it('未知参数键 / 非数字 / 非对象 JSON → 抛错并给出合法键清单', async () => {
    const backtest = makeTool()
    await expect(backtest.execute({ strategyId: 'ema-crossover', market: 'us', symbol: 'AAPL', paramsJson: '{"nope":1}' }))
      .rejects.toThrow(/unknown param "nope"/)
    await expect(backtest.execute({ strategyId: 'ema-crossover', market: 'us', symbol: 'AAPL', paramsJson: '{"fastPeriod":"x"}' }))
      .rejects.toThrow(/must be a finite number/)
    await expect(backtest.execute({ strategyId: 'ema-crossover', market: 'us', symbol: 'AAPL', paramsJson: '[1,2]' }))
      .rejects.toThrow(/must be a JSON object string/)
  })
})
