/**
 * strategy_list / screener_list 名册工具单测（issue #86 / 缺口卡 G3，离线）：
 * 内置范式 + 参数键、自定义记录、内置覆盖、墓碑删除三态一次读全。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryBuiltinTombstonesStore } from '../src/builtin-tombstones.ts'
import { createMemoryCustomStrategyStore } from '../src/custom.ts'
import { createMemoryCustomScreenerStore } from '../src/custom-screener.ts'
import { createScreenerListTool, createStrategyListTool } from '../src/plugin.ts'
import { screenerParadigms, strategyParadigms } from '../src/index.ts'

const VALID_SOURCE = `(bars) => {
  const out = []
  let long = false
  for (let i = 1; i < bars.length; i++) {
    if (!long && i % 2 === 1) { out.push({ index: i, time: bars[i].openTime, action: 'entry', direction: 'long', price: bars[i].close, reason: 'demo' }); long = true }
    else if (long && i % 2 === 0) { out.push({ index: i, time: bars[i].openTime, action: 'exit', direction: 'flat', price: bars[i].close, reason: 'demo' }); long = false }
  }
  return out
}`

type StrategyListWire = {
  ok: boolean
  paradigms: Array<{ id: string; name: string; horizon: string; params: Array<{ key: string; default: number }>; overridden: boolean; deleted: boolean }>
  custom: Array<{ id: string; title: string; horizon: string; createdAt: number }>
  deleted: string[]
}

type ScreenerListWire = {
  ok: boolean
  paradigms: Array<{ id: string; name: string; params: Array<{ key: string }>; columns: Array<{ key: string }>; overridden: boolean; deleted: boolean }>
  custom: Array<{ id: string; title: string; params: Array<{ key: string }>; columns: Array<{ key: string }> }>
  deleted: string[]
}

describe('strategy_list', () => {
  it('内置范式全列 + 参数键；自定义记录进 custom；墓碑进 deleted', async () => {
    const store = createMemoryCustomStrategyStore([{
      id: 'demo-custom', title: '演示自定义', horizon: 'short', summary: '演示',
      paramsJson: '[]', computeSource: VALID_SOURCE, createdAt: 123,
    }])
    const tombstones = createMemoryBuiltinTombstonesStore(['rsi-reversion'])
    const wire = JSON.parse(String(await createStrategyListTool({ store, tombstones }).execute({}))) as StrategyListWire

    expect(wire.ok).toBe(true)
    expect(wire.paradigms).toHaveLength(strategyParadigms.length)
    const ema = wire.paradigms.find(item => item.id === 'ema-crossover')
    expect(ema?.params.length).toBeGreaterThan(0)
    expect(ema?.overridden).toBe(false)
    expect(wire.paradigms.find(item => item.id === 'rsi-reversion')?.deleted).toBe(true)
    expect(wire.deleted).toEqual(['rsi-reversion'])
    expect(wire.custom).toEqual([{ id: 'demo-custom', title: '演示自定义', horizon: 'short', summary: '演示', createdAt: 123 }])
  })

  it('同 id 覆盖内置 → overridden=true 且不重复出现在 custom', async () => {
    const store = createMemoryCustomStrategyStore([{
      id: 'ema-crossover', title: '我的双均线', horizon: 'swing', summary: '覆盖',
      paramsJson: '[]', computeSource: VALID_SOURCE, createdAt: 1,
    }])
    const wire = JSON.parse(String(await createStrategyListTool({ store }).execute({}))) as StrategyListWire
    expect(wire.paradigms.find(item => item.id === 'ema-crossover')?.overridden).toBe(true)
    expect(wire.custom).toEqual([])
  })

  it('墓碑表缺席时 deleted 恒为空数组（老部署）', async () => {
    const wire = JSON.parse(String(await createStrategyListTool({ store: createMemoryCustomStrategyStore() }).execute({}))) as StrategyListWire
    expect(wire.deleted).toEqual([])
    expect(wire.custom).toEqual([])
  })
})

describe('screener_list', () => {
  it('内置选股器含参数键与结果列键；自定义与墓碑各自归位', async () => {
    const store = createMemoryCustomScreenerStore([{
      id: 'scr.custom-demo', title: '演示选股器', horizon: 'swing', summary: '演示',
      paramsJson: JSON.stringify([{ key: 'window', label: '窗口', default: 60, min: 60, max: 500, step: 10 }]),
      columnsJson: JSON.stringify([{ key: 'offHighPct', label: '距高点', format: 'percent' }]),
      evaluateSource: '(bars, params) => null',
      createdAt: 9,
    }])
    const tombstones = createMemoryBuiltinTombstonesStore(['scr.rsi-oversold'])
    const wire = JSON.parse(String(await createScreenerListTool({ store, tombstones }).execute({}))) as ScreenerListWire

    expect(wire.paradigms).toHaveLength(screenerParadigms.length)
    const nearHigh = wire.paradigms.find(item => item.id === 'scr.near-high')
    expect(nearHigh?.params.map(spec => spec.key)).toEqual(['window', 'withinPct'])
    expect(nearHigh?.columns.map(column => column.key)).toEqual(['offHighPct'])
    expect(wire.paradigms.find(item => item.id === 'scr.rsi-oversold')?.deleted).toBe(true)
    expect(wire.deleted).toEqual(['scr.rsi-oversold'])
    expect(wire.custom[0]).toMatchObject({
      id: 'scr.custom-demo',
      title: '演示选股器',
      params: [{ key: 'window' }],
      columns: [{ key: 'offHighPct' }],
    })
  })
})
