/**
 * 策略管理工具单测（2026-09-07）：strategy_delete / strategy_reset /
 * strategy_author 覆盖内置语义 / strategy_backtest 墓碑闸门。
 * 全部离线（内存 store + 假行情）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MarketDataService } from '@dshtrading/api'
import { createMemoryCustomStrategyStore } from '../src/custom.ts'
import { createMemoryBuiltinTombstonesStore } from '../src/builtin-tombstones.ts'
import {
  createStrategyAuthorTool,
  createStrategyBacktestTool,
  createStrategyDeleteTool,
  createStrategyResetTool,
  resolveStrategyDefinition,
} from '../src/plugin.ts'

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
    getKlines: async () => Array.from({ length: 60 }, (_, i) => ({
      openTime: 1700000000000 + i * 86_400_000,
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000,
      closeTime: 1700000000000 + (i + 1) * 86_400_000 - 1,
    })),
    subscribeTicker: () => ({ dispose() {} }),
  }
}

async function authorBuiltinOverride(store: ReturnType<typeof createMemoryCustomStrategyStore>): Promise<void> {
  const author = createStrategyAuthorTool({ store })
  const result = await author.execute({
    id: 'ema-crossover', title: 'EMA 覆盖版', horizon: 'swing', summary: 'x', computeSource: VALID_SOURCE,
  })
  expect(String(result)).toContain('Successfully authored')
}

describe('strategy_delete（策略管理）', () => {
  it('自定义策略 → 移除记录；内置 id → 落墓碑并丢弃覆盖记录', async () => {
    const store = createMemoryCustomStrategyStore()
    const tombstones = createMemoryBuiltinTombstonesStore()
    await authorBuiltinOverride(store)
    const onDeleted = vi.fn()
    const del = createStrategyDeleteTool({ store, tombstones, onDeleted })

    const builtinResult = JSON.parse(String(await del.execute({ id: 'ema-crossover' }))) as { scope: string; deleted: boolean }
    expect(builtinResult).toMatchObject({ scope: 'builtin', deleted: true })
    expect(await tombstones.list()).toEqual(['ema-crossover'])
    // 覆盖记录被一并丢弃（墓碑 + 覆盖并存无意义）。
    expect(await store.get('ema-crossover')).toBeUndefined()
    expect(onDeleted).toHaveBeenCalledWith('ema-crossover', 'builtin', true)

    await authorBuiltinOverride(store)
    const customResult = JSON.parse(String(await del.execute({ id: 'my-own' }))) as { scope: string; deleted: boolean }
    expect(customResult).toMatchObject({ scope: 'custom', deleted: false })
  })

  it('缺少 id → 抛错（defineTool 必填参数拦截）', async () => {
    const del = createStrategyDeleteTool({ store: createMemoryCustomStrategyStore() })
    await expect(del.execute({})).rejects.toThrow('id')
  })
})

describe('strategy_reset（策略管理）', () => {
  it('清覆盖与墓碑恢复出厂；重复 reset → changed:false', async () => {
    const store = createMemoryCustomStrategyStore()
    const tombstones = createMemoryBuiltinTombstonesStore()
    await authorBuiltinOverride(store)
    await tombstones.add('ema-crossover')
    const onReset = vi.fn()
    const reset = createStrategyResetTool({ store, tombstones, onReset })

    const first = JSON.parse(String(await reset.execute({ id: 'ema-crossover' }))) as { changed: boolean; removedOverride: boolean; liftedTombstone: boolean }
    expect(first).toMatchObject({ changed: true, removedOverride: true, liftedTombstone: true })
    expect(onReset).toHaveBeenCalledWith('ema-crossover', true)

    const second = JSON.parse(String(await reset.execute({ id: 'ema-crossover' }))) as { changed: boolean }
    expect(second.changed).toBe(false)
  })

  it('自定义 id → 明确报错引导 strategy_delete', async () => {
    const reset = createStrategyResetTool({ store: createMemoryCustomStrategyStore() })
    await expect(reset.execute({ id: 'my-own' })).rejects.toThrow('strategy_delete')
  })
})

describe('strategy_author 覆盖内置联动', () => {
  it('author 覆盖已删内置 → 顺带清墓碑', async () => {
    const store = createMemoryCustomStrategyStore()
    const tombstones = createMemoryBuiltinTombstonesStore()
    await tombstones.add('ema-crossover')
    const author = createStrategyAuthorTool({ store, tombstones })
    await author.execute({
      id: 'ema-crossover', title: 'EMA 覆盖版', horizon: 'swing', summary: 'x', computeSource: VALID_SOURCE,
    })
    expect(await tombstones.list()).toEqual([])
    expect(await store.get('ema-crossover')).toBeDefined()
  })
})

describe('墓碑闸门（解析与回测）', () => {
  it('resolveStrategyDefinition：墓碑命中的内置 → undefined；覆盖优先于内置', async () => {
    const store = createMemoryCustomStrategyStore()
    const tombstones = createMemoryBuiltinTombstonesStore()
    await authorBuiltinOverride(store)
    expect((await resolveStrategyDefinition(store, 'ema-crossover', { tombstones }))?.name).toBe('EMA 覆盖版')

    await tombstones.add('ema-crossover')
    expect(await resolveStrategyDefinition(store, 'ema-crossover', { tombstones })).toBeUndefined()
    // 墓碑缺席（老部署）→ 覆盖仍生效，内置照常回退。
    expect((await resolveStrategyDefinition(store, 'ema-crossover'))).toBeDefined()
  })

  it('strategy_backtest 已删内置 → 报错引导 strategy_reset', async () => {
    const store = createMemoryCustomStrategyStore()
    const tombstones = createMemoryBuiltinTombstonesStore()
    await tombstones.add('donchian-breakout')
    const tool = createStrategyBacktestTool({ store, tombstones, marketData: () => fakeService() })
    await expect(tool.execute({ strategyId: 'donchian-breakout', market: 'crypto', symbol: 'BTCUSDT' }))
      .rejects.toThrow('strategy_reset')
  })
})
