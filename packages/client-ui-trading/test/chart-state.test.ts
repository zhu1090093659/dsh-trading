/**
 * 图表状态 store 单测：默认 MA 实例、togglePreset 开关、setParams
 * 更新/补建、isActive/instanceFor、未知 id 无操作。注册表 = 工厂实例
 * + presetDefinitions 注册（模拟指标插件桥接后的状态）。
 */
import { describe, expect, it } from 'vitest'
import { createIndicatorRegistry, presetDefinitions } from '@dshtrading/indicators'
import { createChartStateStore } from '../src/client/chart-state.ts'

function makeStore() {
  const registry = createIndicatorRegistry()
  for (const definition of presetDefinitions()) registry.register(definition)
  return createChartStateStore(registry)
}
describe('chart-state store', () => {
  it('默认激活 MA(5/10/20/30/60/120)', () => {
    const store = makeStore()
    expect(store.getSnapshot().instances).toEqual([
      { id: 'ma', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 } },
    ])
    expect(store.isActive('ma')).toBe(true)
    expect(store.isActive('macd')).toBe(false)
  })

  it('togglePreset 开关副图指标', () => {
    const store = makeStore()
    store.togglePreset('macd')
    expect(store.instanceFor('macd')).toEqual({ id: 'macd', params: { fast: 12, slow: 26, signal: 9 } })
    store.togglePreset('macd')
    expect(store.isActive('macd')).toBe(false)
    expect(store.isActive('ma')).toBe(true)
  })

  it('setParams 更新已有实例；未激活时补建', () => {
    const store = makeStore()
    store.setParams('ma', { n1: 5, n2: 10, n3: 60, n4: 30, n5: 60, n6: 120 })
    expect(store.instanceFor('ma')?.params).toEqual({ n1: 5, n2: 10, n3: 60, n4: 30, n5: 60, n6: 120 })
    expect(store.getSnapshot().instances).toHaveLength(1)
    store.setParams('rsi', { n: 6 })
    expect(store.instanceFor('rsi')).toEqual({ id: 'rsi', params: { n: 6 } })
  })

  it('未知 id 的 toggle/setParams 为无 default/clamp 原样落盘（防御手改 localStorage）', () => {
    const store = makeStore()
    store.togglePreset('ghost')
    expect(store.instanceFor('ghost')).toEqual({ id: 'ghost', params: {} })
    store.setParams('ghost', { n: 1 })
    expect(store.instanceFor('ghost')).toEqual({ id: 'ghost', params: { n: 1 } })
    // 已知 id 的 setParams 仍走 clamp 边界。
    store.setParams('ma', { n1: 9999 })
    expect(store.instanceFor('ma')?.params.n1).toBe(250)
  })

  it('空注册表（插件未装）：持久化/默认实例原样保留不清洗，插件就位后自动生效', () => {
    const store = createChartStateStore(createIndicatorRegistry())
    expect(store.getSnapshot().instances).toEqual([{ id: 'ma', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 } }])
    store.setParams('rsi', { n: 6 })
    expect(store.instanceFor('rsi')).toEqual({ id: 'rsi', params: { n: 6 } })
  })
})
