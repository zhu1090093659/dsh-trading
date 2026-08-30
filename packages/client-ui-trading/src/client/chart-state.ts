/**
 * 图表状态 store：当前激活的指标实例列表（每 preset id 至多一个实例）。
 * 仿 selection/watchlist store 模式：无依赖可观测 + localStorage 持久化。
 * 读回时按注册表净化——未知 id（自定义指标卸载后）与越界参数不炸。
 * 注册表由 apply 注入（本地单例，指标插件经桥接合并 definition）。
 */
import type { IndicatorInstance, IndicatorRegistry } from '@dsh-trading/indicators'
import { createObservable, readJson, writeJson } from './store.ts'
import type { WritableObservable } from './store.ts'

const CHART_KEY = 'dshtrading.chart.v1'

export interface ChartState {
  instances: IndicatorInstance[]
}

export interface ChartStateStore extends WritableObservable<ChartState> {
  /** 切换某 preset：无实例 → 加默认实例；有 → 全部移除。 */
  togglePreset(id: string): void
  /** 更新（或补建）某 preset 的唯一实例参数。 */
  setParams(id: string, params: Record<string, number>): void
  instanceFor(id: string): IndicatorInstance | undefined
  isActive(id: string): boolean
}

/** 默认激活：MA(5/10/20)，与退役 SVG 图表的既视感一致。 */
function initialState(registry: IndicatorRegistry): ChartState {
  const ma = registry.defaultInstance('ma')
  return { instances: ma !== undefined ? [ma] : [] }
}

export function createChartStateStore(registry: IndicatorRegistry): ChartStateStore {
  const store = createObservable<ChartState>({
    instances: registry.sanitizeInstances(readJson<unknown>(CHART_KEY, initialState(registry).instances)),
  })

  const persist = (): void => { writeJson(CHART_KEY, store.getSnapshot().instances) }

  return {
    ...store,
    togglePreset(id) {
      const definition = registry.get(id)
      if (definition === undefined) return
      store.update((current) => {
        const rest = current.instances.filter(instance => instance.id !== id)
        if (rest.length !== current.instances.length) return { instances: rest }
        const fresh = registry.defaultInstance(id)
        return fresh !== undefined ? { instances: [...current.instances, fresh] } : current
      })
      persist()
    },
    setParams(id, params) {
      const definition = registry.get(id)
      if (definition === undefined) return
      store.update((current) => {
        const exists = current.instances.some(instance => instance.id === id)
        const clamped = registry.clampParams(definition, params)
        const instances = exists
          ? current.instances.map(instance => instance.id === id ? { id, params: clamped } : instance)
          : [...current.instances, { id, params: clamped }]
        return { instances }
      })
      persist()
    },
    instanceFor(id) {
      return store.getSnapshot().instances.find(instance => instance.id === id)
    },
    isActive(id) {
      return store.getSnapshot().instances.some(instance => instance.id === id)
    },
  }
}
