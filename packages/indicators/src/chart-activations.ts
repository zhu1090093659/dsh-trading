/**
 * 图表激活名册（issue #63）：当前挂在用户图上的指标实例列表（每 id 至多一个实例）。
 * 与 custom.ts 同款分层——本模块纯数据 + 内存存储（浏览器安全，零 Node.js 运行时
 * 依赖），文件持久化版在 chart-activations-fs.ts（Node 宿主侧）。
 *
 * SSOT 语义（issue #32 watchlist 先例）：host 侧 store 为权威，客户端 localStorage
 * 降级为镜像。写入边界（工具 / 桥）负责按 definition clamp 参数，store 本身保持
 * 「哑存储」：只校验形状，不理解指标语义。
 */
import type { IndicatorInstance, IndicatorPane, IndicatorParamSpec } from './types.ts'
import type { CustomIndicatorStore } from './custom.ts'
import { presetDefinitions } from './presets.ts'

/** 激活名册存储接口（工具、桥、单测共用）。 */
export interface ChartActivationStore {
  /** 全量读取（插入序，即挂载序）。 */
  list(): Promise<IndicatorInstance[]>
  /** 挂载/更新：同 id 覆盖参数（upsert），保持每 id 至多一个实例。 */
  activate(instance: IndicatorInstance): Promise<void>
  /** 摘除；返回是否确有该实例。 */
  deactivate(id: string): Promise<boolean>
  /** 全量替换（一次性迁移导入 / 客户端启动同步用）。 */
  replaceAll(instances: IndicatorInstance[]): Promise<void>
}

/** 指标定义的最小解析面（预置或自定义；pane/title 仅供工具输出展示）。 */
export interface IndicatorSpecLike {
  id: string
  title: string
  pane: IndicatorPane
  params: readonly IndicatorParamSpec[]
  /** 自定义指标才有的可选描述。 */
  description?: string
}

/** 实例形状防御：id 非空字符串 + params 纯有限数字对象（坏形丢弃，SSOT 不收脏数据）。 */
function isValidInstance(raw: unknown): raw is IndicatorInstance {
  if (typeof raw !== 'object' || raw === null) return false
  const id = (raw as { id?: unknown }).id
  const params = (raw as { params?: unknown }).params
  if (typeof id !== 'string' || id.trim() === '') return false
  if (typeof params !== 'object' || params === null) return false
  return Object.values(params as Record<string, unknown>).every(v => typeof v === 'number' && Number.isFinite(v))
}

/** 内存版激活名册存储（纯浏览器与单测用）。 */
export function createMemoryChartActivationStore(initial: IndicatorInstance[] = []): ChartActivationStore {
  const map = new Map<string, IndicatorInstance>()
  for (const item of initial) {
    if (isValidInstance(item)) map.set(item.id, { id: item.id, params: { ...item.params } })
  }

  return {
    list: async () => [...map.values()].map(instance => ({ id: instance.id, params: { ...instance.params } })),
    activate: async (instance) => {
      if (!isValidInstance(instance)) {
        const id = (instance as { id?: unknown } | null | undefined)?.id
        throw new Error('chart activation: invalid instance shape for id ' + JSON.stringify(id))
      }
      map.set(instance.id, { id: instance.id, params: { ...instance.params } })
    },
    deactivate: async (id) => map.delete(id),
    replaceAll: async (instances) => {
      map.clear()
      for (const item of instances) {
        if (isValidInstance(item)) map.set(item.id, { id: item.id, params: { ...item.params } })
      }
    },
  }
}

/**
 * 解析指标定义（预置优先，其次自定义 store）：未知 id 返回 undefined。
 * 工具与桥的写入边界共用，保证「能挂上图的 id」与「GUI 能渲染的 id」同源。
 */
export async function resolveIndicatorSpec(id: string, customStore?: CustomIndicatorStore): Promise<IndicatorSpecLike | undefined> {
  const preset = presetDefinitions().find(d => d.id === id)
  if (preset !== undefined) {
    return { id: preset.id, title: preset.title, pane: preset.pane, params: preset.params }
  }
  if (customStore !== undefined) {
    const record = await customStore.get(id)
    if (record !== undefined) {
      return { id: record.id, title: record.title, pane: record.pane, params: record.params, description: record.description }
    }
  }
  return undefined
}

/**
 * 参数按 schema clamp（与 registry.clampParams 同规则，独立实现供 host 写入
 * 边界使用——host 平面没有注册表实例）：有限数字 → min/max 收敛 + 取整；缺失/
 * 非法 → schema 默认值；schema 外的键丢弃。definition 未知时原样透传有限数字
 * 键（预置/自定义尚未就位的实例仍可落盘，UI 对未知 id 天然不可见）。
 */
export function clampActivationParams(specs: readonly IndicatorParamSpec[] | undefined, params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  if (specs === undefined) {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  }
  for (const spec of specs) {
    const raw = params[spec.key]
    out[spec.key] = typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(spec.max, Math.max(spec.min, Math.round(raw)))
      : spec.default
  }
  return out
}

/** 按 schema 生成默认参数实例（definition 缺席 → 空 params，UI 不可见兜底）。 */
export function defaultActivationInstance(spec: IndicatorSpecLike): IndicatorInstance {
  const params: Record<string, number> = {}
  for (const p of spec.params) params[p.key] = p.default
  return { id: spec.id, params }
 }
