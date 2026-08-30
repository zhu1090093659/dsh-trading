/**
 * 指标注册表：指标系统的扩展点。每个指标是一个纯数据/纯函数的
 * definition（pane 归属 + 参数 schema + compute），渲染层（TvChart）
 * 只消费 compute 的输出，对指标实现零感知。
 *
 * 自定义指标的接入方式 = 往 registry 里放一个 definition（未来用户
 * 自定义指标从设置/localStorage 加载后同样走 registerIndicator）。
 */
import type { MarketLocaleKey } from '../contract.ts'
import type { Kline } from '../types.ts'
import type { Series } from './math.ts'

/** 指标归属：主图叠加（与蜡烛共享价格轴）或独立副图 pane。 */
export type IndicatorPane = 'main' | 'sub'

export interface IndicatorParamSpec {
  key: string
  labelKey: MarketLocaleKey
  default: number
  min: number
  max: number
}

export interface IndicatorOutput {
  /** 实例内唯一（图例/序列 key）。 */
  key: string
  kind: 'line' | 'histogram'
  color: string
  /** 与 K 线逐条对齐；undefined = warm-up，不画。 */
  values: Series
  /** histogram 专用：按符号红涨绿跌着色（MACD 柱）。 */
  histogramBySign?: boolean
}

export interface IndicatorDefinition {
  /** 注册唯一 id（如 'ma'）；实例按 id + 参数区分。 */
  id: string
  pane: IndicatorPane
  titleKey: MarketLocaleKey
  params: readonly IndicatorParamSpec[]
  compute(bars: readonly Kline[], params: Readonly<Record<string, number>>): IndicatorOutput[]
}

/** 一个已激活的指标实例（每个 preset id 至多一个实例）。 */
export interface IndicatorInstance {
  id: string
  params: Record<string, number>
}

const registry = new Map<string, IndicatorDefinition>()

/** 注册指标；同名覆盖（开发热替换友好）。 */
export function registerIndicator(definition: IndicatorDefinition): void {
  registry.set(definition.id, definition)
}

export function getIndicator(id: string): IndicatorDefinition | undefined {
  return registry.get(id)
}

export function listIndicators(): IndicatorDefinition[] {
  return [...registry.values()]
}

/** 按 schema 生成默认参数。 */
export function defaultParams(definition: IndicatorDefinition): Record<string, number> {
  const params: Record<string, number> = {}
  for (const spec of definition.params) params[spec.key] = spec.default
  return params
}

/** 生成 schema 默认实例。 */
export function defaultInstance(id: string): IndicatorInstance | undefined {
  const definition = registry.get(id)
  if (definition === undefined) return undefined
  return { id, params: defaultParams(definition) }
}

/** 实例的稳定 key（图例、DOM、diff 用）。 */
export function instanceKey(instance: IndicatorInstance): string {
  const values = definitionParams(instance.id).map(spec => instance.params[spec.key] ?? spec.default)
  return `${instance.id}:${values.join(',')}`
}

function definitionParams(id: string): readonly IndicatorParamSpec[] {
  return registry.get(id)?.params ?? []
}

/** 实例参数按 schema clamp（防 localStorage 脏值越界）。 */
export function clampParams(
  definition: IndicatorDefinition,
  params: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const spec of definition.params) {
    const raw = params[spec.key]
    out[spec.key] = typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(spec.max, Math.max(spec.min, Math.round(raw)))
      : spec.default
  }
  return out
}

/**
 * 持久化读回的实例列表净化：未知 id 丢弃（自定义指标卸载后不炸）、
 * 参数 clamp、按 id 去重（每 preset 至多一个实例）。
 */
export function sanitizeInstances(instances: unknown): IndicatorInstance[] {
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
    out.push({ id, params: clampParams(definition, (typeof params === 'object' && params !== null ? params : {}) as Record<string, number>) })
  }
  return out
}
