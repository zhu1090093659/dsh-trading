/**
 * 图表状态 store：当前激活的指标实例列表（每 preset id 至多一个实例）。
 * 仿 selection/watchlist store 模式：无依赖可观测 + localStorage 持久化。
 *
 * 3.2 插件化后注册表异步就位（指标插件经 ctx.inject 桥接），创建时对
 * 「还空的注册表」sanitize 会把持久化激活态清掉——因此创建只读原始实例
 * 列表不清洗：未知 id 实例对 UI 天然不可见（选择器按 definition 名册渲染、
 * 指标调度按 indicators.get 跳过），插件就位后自动生效。default/clamp
 * 收敛在 toggle/setParams 写入边界（定义未知时原样落盘：桥接前选择器没有
 * 该 id 的可点行，此分支 UI 不可达，防御手改 localStorage）。
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

/** 默认激活：MA(5/10/20/30/60/120)，与富途 6 均线既视感一致。注册表未就位时
    留作未知实例（UI 不可见），插件桥接后自动点亮。 */
function initialState(): ChartState {
  return { instances: [{ id: 'ma', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 } }] }
}

export function createChartStateStore(registry: IndicatorRegistry): ChartStateStore {
  const store = createObservable<ChartState>({
    instances: readJson<IndicatorInstance[]>(CHART_KEY, initialState().instances),
  })

  const persist = (): void => { writeJson(CHART_KEY, store.getSnapshot().instances) }

  return {
    ...store,
    togglePreset(id) {
      const definition = registry.get(id)
      store.update((current) => {
        const rest = current.instances.filter(instance => instance.id !== id)
        if (rest.length !== current.instances.length) return { instances: rest }
        return { instances: [...current.instances, { id, params: definition !== undefined ? registry.defaultParams(definition) : {} }] }
      })
      persist()
    },
    setParams(id, params) {
      const definition = registry.get(id)
      const clamped = definition !== undefined ? registry.clampParams(definition, params) : params
      store.update((current) => {
        const exists = current.instances.some(instance => instance.id === id)
        return { instances: exists
          ? current.instances.map(instance => instance.id === id ? { id, params: clamped } : instance)
          : [...current.instances, { id, params: clamped }] }
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
