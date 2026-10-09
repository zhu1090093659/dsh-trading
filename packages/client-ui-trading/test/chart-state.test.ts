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

  it('setParams 带 scopeKey 写按标的覆盖（issue #72）；全局写保留覆盖表', () => {
    const store = makeStore()
    // 已有全局实例 → 写覆盖不动全局 params
    store.setParams('ma', { n1: 7 }, 'hk:00700.HK')
    expect(store.instanceFor('ma')).toEqual({
      id: 'ma',
      params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 },
      symbolParams: { 'hk:00700.HK': { n1: 7, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 } },
    })
    // 全局写保留覆盖
    store.setParams('ma', { n1: 8 })
    expect(store.instanceFor('ma')?.params.n1).toBe(8)
    expect(store.instanceFor('ma')?.symbolParams?.['hk:00700.HK']?.n1).toBe(7)
    // 未激活实例带 scopeKey → 补建全局默认 + 该标的覆盖
    store.setParams('rsi', { n: 6 }, 'us:GOOGL')
    expect(store.instanceFor('rsi')).toEqual({
      id: 'rsi', params: { n: 14 }, symbolParams: { 'us:GOOGL': { n: 6 } },
    })
  })

  it('setSymbolVisibility：symbol 级隐藏/显示，其它标的与全局 params 不受影响（symbol visibility）', () => {
    const store = makeStore()
    // 隐藏当前标的：实例保留，仅 hiddenScopes 记录
    store.setSymbolVisibility('ma', 'us', 'AAPL', false)
    expect(store.instanceFor('ma')).toEqual({
      id: 'ma',
      params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 },
      hiddenScopes: ['us:AAPL'],
    })
    expect(store.isActive('ma')).toBe(true)
    // 追加另一标的隐藏 → 再显示第一个：只清该标的，其余保留
    store.setSymbolVisibility('ma', 'hk', '00700.HK', false)
    store.setSymbolVisibility('ma', 'us', 'AAPL', true)
    expect(store.instanceFor('ma')?.hiddenScopes).toEqual(['hk:00700.HK'])
    // 逐个清空后字段整体消失
    store.setSymbolVisibility('ma', 'hk', '00700.HK', true)
    expect(store.instanceFor('ma')).toEqual({
      id: 'ma', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 },
    })
    // 未激活 id：静默 no-op
    store.setSymbolVisibility('rsi', 'us', 'AAPL', false)
    expect(store.isActive('rsi')).toBe(false)
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

  it('用户设置某市场适用范围后重载仍保持同一配置（适用范围持久化）', () => {
    withStorage(() => {
      // Given 一个已挂载的 EMA 实例
      const store = makeStore()
      store.togglePreset('ema')

      // When 把美股限为日 K、港股关闭但保留 15m
      store.setMarketScope('ema', 'us', { enabled: true, intervals: ['1d'] })
      store.setMarketScope('ema', 'hk', { enabled: false, intervals: ['15m'] })

      // Then 快照与重载镜像都保留同一适用范围
      expect(store.instanceFor('ema')?.applyScope).toEqual({
        us: { enabled: true, intervals: ['1d'] },
        hk: { enabled: false, intervals: ['15m'] },
      })
      expect(makeStore().instanceFor('ema')?.applyScope).toEqual({
        us: { enabled: true, intervals: ['1d'] },
        hk: { enabled: false, intervals: ['15m'] },
      })
    })
  })

  it('用户关闭市场只停用不清空级别，重新开启恢复原选择', () => {
    // Given 港股只选了 15m 的实例
    const store = makeStore()
    store.togglePreset('ema')
    store.setMarketScope('ema', 'hk', { enabled: true, intervals: ['15m'] })

    // When 关闭港股（enabled=false，级别原样提交）
    store.setMarketScope('ema', 'hk', { enabled: false, intervals: ['15m'] })

    // Then 级别选择仍在；重新开启即恢复
    expect(store.instanceFor('ema')?.applyScope?.hk).toEqual({ enabled: false, intervals: ['15m'] })
    store.setMarketScope('ema', 'hk', { enabled: true, intervals: ['15m'] })
    expect(store.instanceFor('ema')?.applyScope?.hk).toEqual({ enabled: true, intervals: ['15m'] })
  })

  it('用户删除某市场适用范围条目后该键消失，未挂载 id 静默', () => {
    // Given 美股与港股两条适用范围
    const store = makeStore()
    store.togglePreset('ema')
    store.setMarketScope('ema', 'us', { enabled: true, intervals: ['1d'] })
    store.setMarketScope('ema', 'hk', { enabled: true, intervals: ['15m'] })

    // When 删除美股条目
    store.setMarketScope('ema', 'us', undefined)

    // Then 只剩港股；对未挂载 id 写适用范围无操作
    expect(store.instanceFor('ema')?.applyScope).toEqual({ hk: { enabled: true, intervals: ['15m'] } })
    store.setMarketScope('rsi', 'us', { enabled: true, intervals: ['1d'] })
    expect(store.isActive('rsi')).toBe(false)
  })

  it('用户调整参数不会被适用范围设置干扰（两者正交）', () => {
    // Given 带适用范围的实例
    const store = makeStore()
    store.togglePreset('ema')
    store.setMarketScope('ema', 'us', { enabled: true, intervals: ['1d'] })

    // When 改全局参数
    store.setParams('ema', { n1: 9, n2: 21, n3: 20, n4: 30, n5: 60, n6: 120 })

    // Then 参数更新且适用范围原样保留
    expect(store.instanceFor('ema')?.params.n1).toBe(9)
    expect(store.instanceFor('ema')?.applyScope).toEqual({ us: { enabled: true, intervals: ['1d'] } })
  })

  it('空注册表（插件未装）：持久化/默认实例原样保留不清洗，插件就位后自动生效', () => {
    const store = createChartStateStore(createIndicatorRegistry())
    expect(store.getSnapshot().instances).toEqual([{ id: 'ma', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 } }])
    store.setParams('rsi', { n: 6 })
    expect(store.instanceFor('rsi')).toEqual({ id: 'rsi', params: { n: 6 } })
  })
})

/** 本次用例专用的 localStorage 假件：测试棘轮禁用 vi.* 通用 mock，这里手写契约假件，用完还原全局。 */
function withStorage(run: () => void): void {
  const backing = new Map<string, string>()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, value) },
      removeItem: (key: string) => { backing.delete(key) },
    },
  })
  try {
    run()
  } finally {
    if (descriptor === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', descriptor)
  }
}

describe('chart-state 镜像持久化（host 名册落地，2026-09-16）', () => {
  it('用户遇到 agent 挂载的指标名册后重载仍点亮同一名册（applyHost 持久化）', () => {
    withStorage(() => {
      // Given 本地默认名册（MA），host 权威名册为 MACD 单实例
      const store = makeStore()
      const hostRoster = [{ id: 'macd', params: { fast: 12, slow: 26, signal: 9 } }]
      // When host 名册经 applyHost 落地
      store.applyHost(hostRoster)
      // Then 快照与重载镜像都是 host 名册（桥降级不再回落默认 MA）
      expect(store.getSnapshot().instances).toEqual(hostRoster)
      expect(makeStore().getSnapshot().instances).toEqual(hostRoster)
    })
  })
})
