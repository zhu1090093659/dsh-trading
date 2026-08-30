/**
 * 指标注册表工厂：指标系统的运行时扩展点。每个消费方（宿主行情视图、
 * 指标插件）创建自己的实例——ESM 各 bundle 独立打包，跨包共享只能经
 * cordis 服务单例（client-ui-indicators 的 tradingIndicators），不能靠
 * 模块级单例（双 Map 静默分裂）。
 *
 * 自定义/社区指标的接入 = 拿到注册表实例后 register(definition)。
 */
import type {
  IndicatorDefinition, IndicatorInstance, IndicatorParamSpec,
} from './types.ts'

export interface IndicatorRegistry {
  /** 注册指标；同名覆盖（开发热替换友好），并通知订阅者。 */
  register(definition: IndicatorDefinition): void
  get(id: string): IndicatorDefinition | undefined
  list(): IndicatorDefinition[]
  /** 按 schema 生成默认参数。 */
  defaultParams(definition: IndicatorDefinition): Record<string, number>
  /** 生成 schema 默认实例。 */
  defaultInstance(id: string): IndicatorInstance | undefined
  /** 实例的稳定 key（图例、DOM、diff 用）。 */
  instanceKey(instance: IndicatorInstance): string
  /** 实例参数按 schema clamp（防 localStorage 脏值越界）。 */
  clampParams(definition: IndicatorDefinition, params: Record<string, number>): Record<string, number>
  /** 持久化读回的实例列表净化：未知 id 丢弃、参数 clamp、按 id 去重。 */
  sanitizeInstances(instances: unknown): IndicatorInstance[]
  /** 订阅名册变化（注册/覆盖）；返回退订函数。UI 据此重渲染名册。 */
  subscribe(listener: () => void): () => void
  /** 名册修订号（单调递增）；配合 subscribe 供 useSyncExternalStore。 */
  getVersion(): number
}

export function createIndicatorRegistry(): IndicatorRegistry {
  const registry = new Map<string, IndicatorDefinition>()
  const listeners = new Set<() => void>()
  let version = 0

  const register = (definition: IndicatorDefinition): void => {
    registry.set(definition.id, definition)
    version += 1
    for (const listener of listeners) listener()
  }

  const definitionParams = (id: string): readonly IndicatorParamSpec[] =>
    registry.get(id)?.params ?? []

  return {
    register,
    get: id => registry.get(id),
    list: () => [...registry.values()],
    defaultParams(definition) {
      const params: Record<string, number> = {}
      for (const spec of definition.params) params[spec.key] = spec.default
      return params
    },
    defaultInstance(id) {
      const definition = registry.get(id)
      if (definition === undefined) return undefined
      return { id, params: this.defaultParams(definition) }
    },
    instanceKey(instance) {
      const values = definitionParams(instance.id).map(spec => instance.params[spec.key] ?? spec.default)
      return `${instance.id}:${values.join(',')}`
    },
    clampParams(definition, params) {
      const out: Record<string, number> = {}
      for (const spec of definition.params) {
        const raw = params[spec.key]
        out[spec.key] = typeof raw === 'number' && Number.isFinite(raw)
          ? Math.min(spec.max, Math.max(spec.min, Math.round(raw)))
          : spec.default
      }
      return out
    },
    sanitizeInstances(instances) {
      if (!Array.isArray(instances)) return []
      const seen = new Set<string>()
      const out: IndicatorInstance[] = []
      for (const raw of instances) {
        if (typeof raw !== 'object' || raw === null) continue
        const { id, params } = raw as { id?: unknown; params?: unknown }
        if (typeof id !== 'string' || seen.has(id)) continue
        const definition = registry.get(id)
        if (definition === undefined) continue
        seen.add(id)
        out.push({ id, params: this.clampParams(definition, (typeof params === 'object' && params !== null ? params : {}) as Record<string, number>) })
      }
      return out
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getVersion: () => version,
  }
}
