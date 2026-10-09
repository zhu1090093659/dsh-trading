/**
 * 图表激活名册（issue #63）：当前挂在用户图上的指标实例列表（每 id 至多一个实例）。
 * 与 custom.ts 同款分层——本模块纯数据 + 内存存储（浏览器安全，零 Node.js 运行时
 * 依赖），文件持久化版在 chart-activations-fs.ts（Node 宿主侧）。
 *
 * SSOT 语义（issue #32 watchlist 先例）：host 侧 store 为权威，客户端 localStorage
 * 降级为镜像。写入边界（工具 / 桥）负责按 definition clamp 参数，store 本身保持
 * 「哑存储」：只校验形状，不理解指标语义。
 */
import type {
  IndicatorApplyScope, IndicatorInstance, IndicatorMarketScope, IndicatorPane, IndicatorParamSpec,
} from './types.ts'
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

/** 按标的覆盖表防御性清洗（issue #72）：非法键/值整体丢弃该字段，不连累实例本体。 */
function sanitizeSymbolParams(raw: unknown): Record<string, Record<string, number>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Record<string, Record<string, number>> = {}
  for (const [scope, params] of Object.entries(raw as Record<string, unknown>)) {
    if (scope.trim() === '' || typeof params !== 'object' || params === null || Array.isArray(params)) continue
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value
    }
    if (Object.keys(clean).length > 0) out[scope] = clean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 按标的隐藏表防御性清洗：只留非空字符串并去重；空表返回 undefined（字段整体消失）。 */
function sanitizeHiddenScopes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const key = item.trim()
    if (key !== '' && !out.includes(key)) out.push(key)
  }
  return out.length > 0 ? out : undefined
}

/**
 * 适用范围防御性清洗：市场键须非空字符串，值须为 { enabled: boolean, intervals: string[] }
 * 形状；级别去空白、去重、丢非字符串。**形状不合格的整个市场条目丢弃**（而不是补默认
 * 值）——否则一条手写/损坏的条目会被读成「该市场未选级别」而静默停用；丢弃后该市场
 * 落回「缺席 = 全部级别应用」，与存量配置同语义。全部条目被丢弃时字段整体消失。
 */
export function sanitizeApplyScope(raw: unknown): IndicatorApplyScope | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: IndicatorApplyScope = {}
  for (const [market, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = market.trim()
    if (key === '' || typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const scene = value as { enabled?: unknown; intervals?: unknown }
    if (typeof scene.enabled !== 'boolean' || !Array.isArray(scene.intervals)) continue
    const intervals: string[] = []
    for (const item of scene.intervals) {
      if (typeof item !== 'string') continue
      const level = item.trim()
      if (level !== '' && !intervals.includes(level)) intervals.push(level)
    }
    out[key] = { enabled: scene.enabled, intervals }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 深拷贝规范化一个实例（params/symbolParams/hiddenScopes/applyScope 均脱引用）；坏形返回 undefined。 */
export function sanitizeInstance(raw: unknown): IndicatorInstance | undefined {
  if (!isValidInstance(raw)) return undefined
  const params = { ...(raw.params as Record<string, number>) }
  const symbolParams = sanitizeSymbolParams((raw as { symbolParams?: unknown }).symbolParams)
  const hiddenScopes = sanitizeHiddenScopes((raw as { hiddenScopes?: unknown }).hiddenScopes)
  const applyScope = sanitizeApplyScope((raw as { applyScope?: unknown }).applyScope)
  let clean: IndicatorInstance = { id: raw.id, params }
  if (symbolParams !== undefined) clean = { ...clean, symbolParams }
  if (hiddenScopes !== undefined) clean = { ...clean, hiddenScopes }
  if (applyScope !== undefined) clean = { ...clean, applyScope }
  return clean
}

/** 按标的覆盖的 scope 键：`${market}:${symbol}`（与 client QuoteStage 的 market/symbol 同源）。 */
export function symbolScopeKey(market: string, symbol: string): string {
  return market + ':' + symbol
}

/**
 * 实例对某标的的生效参数（issue #72）：symbolParams 命中 `${market}:${symbol}`
 * 时整体替代全局 params；market/symbol 缺失或无覆盖 → 全局 params。
 */
export function effectiveInstanceParams(
  instance: IndicatorInstance,
  market?: string,
  symbol?: string,
): Record<string, number> {
  if (market !== undefined && symbol !== undefined && instance.symbolParams !== undefined) {
    const scoped = instance.symbolParams[symbolScopeKey(market, symbol)]
    if (scoped !== undefined) return scoped
  }
  return instance.params
}

/**
 * 实例对某标的的可见性：hiddenScopes 命中「market」或「${market}:${symbol}」任一
 * 作用域即隐藏；无隐藏记录默认可见（存量名册零迁移）。market 缺失（GUI 无聚焦
 * 标的）按可见处理——调用方此时走全局开关语义。
 */
export function isInstanceVisibleOn(instance: IndicatorInstance, market?: string, symbol?: string): boolean {
  const scopes = instance.hiddenScopes
  if (scopes === undefined || scopes.length === 0 || market === undefined) return true
  if (scopes.includes(market)) return false
  if (symbol !== undefined && scopes.includes(symbolScopeKey(market, symbol))) return false
  return true
}

/**
 * 纯函数切换实例对一个作用域（「market」或「${market}:${symbol}」）的可见性：
 * visible=false 记隐藏（已记录则原引用返回），visible=true 清隐藏（清空后字段
 * 整体消失；本就无记录则原引用返回）。不触碰 params/symbolParams。
 */
export function withHiddenScopes(instance: IndicatorInstance, scope: string, visible: boolean): IndicatorInstance {
  const scopes = instance.hiddenScopes ?? []
  if (!visible) {
    return scopes.includes(scope) ? instance : { ...instance, hiddenScopes: [...scopes, scope] }
  }
  const next = scopes.filter(key => key !== scope)
  if (next.length === scopes.length) return instance
  if (next.length === 0) {
    const rest = { ...instance }
    delete rest.hiddenScopes
    return rest
  }
  return { ...instance, hiddenScopes: next }
}

/**
 * 实例对「某市场 + 某 K 线级别」的适用性（适用范围设置的唯一读侧判据）。
 *
 * - 实例没有该市场条目（含 applyScope 字段整体缺失）→ 适用：新建指标与存量
 *   配置都是「全部市场、全部级别应用」，零迁移。
 * - 条目存在但 `enabled: false` → 不适用（市场关闭；已选级别保留不动）。
 * - 条目存在且启用、`intervals` 为空 → 不适用（「未选择级别」；空选择绝不解释
 *   为全部级别）。
 * - 条目存在且启用、选中级别不含当前级别 → 不适用。
 *
 * market 缺失（GUI 无聚焦标的）按适用处理——调用方此时无市场上下文可判。
 */
export function isInstanceApplicableOn(
  instance: IndicatorInstance,
  market?: string,
  interval?: string,
): boolean {
  if (market === undefined) return true
  const scene = instance.applyScope?.[market]
  if (scene === undefined) return true
  if (!scene.enabled) return false
  if (scene.intervals.length === 0) return false
  if (interval === undefined) return true
  return scene.intervals.includes(interval)
}

/**
 * 纯函数设置某市场的适用范围条目：`scene === undefined` 表示删除该市场条目
 * （落回「缺席 = 全部级别应用」）。条目删空后字段整体消失；市场键保持既有插入序，
 * 新键追加。与既有条目完全一致时返回原引用（不触发无意义持久化）。不触碰
 * params/symbolParams/hiddenScopes。
 */
export function withMarketScope(
  instance: IndicatorInstance,
  market: string,
  scene: IndicatorMarketScope | undefined,
): IndicatorInstance {
  const current = instance.applyScope
  if (scene === undefined) {
    if (current === undefined || current[market] === undefined) return instance
    const rest: IndicatorApplyScope = {}
    for (const [key, value] of Object.entries(current)) if (key !== market) rest[key] = value
    if (Object.keys(rest).length === 0) {
      const next = { ...instance }
      delete next.applyScope
      return next
    }
    return { ...instance, applyScope: rest }
  }
  if (current?.[market] !== undefined
    && current[market]?.enabled === scene.enabled
    && current[market]?.intervals.length === scene.intervals.length
    && scene.intervals.every((level, index) => current[market]?.intervals[index] === level)) {
    return instance
  }
  return { ...instance, applyScope: { ...(current ?? {}), [market]: { enabled: scene.enabled, intervals: [...scene.intervals] } } }
}

/**
 * 全局 params 写的共用保留规则：按标的覆盖表（symbolParams）、隐藏表
 * （hiddenScopes）与适用范围（applyScope）三者都与 params 正交，全局调参一次
 * 不得静默清掉它们。桥、indicator_activate 与 indicator_author 的全局写共用本函数
 *（一个事实只有一个家）。
 *
 * 语义边界：只用于「写全局 params，其它三者保持不动」的写入。按标的覆盖写
 *（clearSymbol 要真的删除覆盖、activate 要真的清该标的隐藏）语义不同，由各写入口
 * 显式构造，不走本函数——否则「清空覆盖」会被继承规则反向补回。
 */
export function carryInstanceExtras(base: IndicatorInstance | undefined, next: IndicatorInstance): IndicatorInstance {
  const merged: IndicatorInstance = { ...next }
  if (merged.symbolParams === undefined && base?.symbolParams !== undefined) merged.symbolParams = base.symbolParams
  if (merged.hiddenScopes === undefined && base?.hiddenScopes !== undefined) merged.hiddenScopes = base.hiddenScopes
  if (merged.applyScope === undefined && base?.applyScope !== undefined) merged.applyScope = base.applyScope
  return merged
}

/**
 * 某市场在适用范围里的「有效选择」（GUI 呈现实值）：条目缺席即「全部级别应用」，
 * 返回 enabled=true + 传入的该市场全部支持级别。条目存在则原样返回其选择
 *（选择为空即空——「未选择级别」）。
 */
export function effectiveMarketScope(
  instance: IndicatorInstance,
  market: string,
  supportedIntervals: readonly string[],
): IndicatorMarketScope {
  const scene = instance.applyScope?.[market]
  if (scene === undefined) return { enabled: true, intervals: [...supportedIntervals] }
  return { enabled: scene.enabled, intervals: [...scene.intervals] }
}

/** 内存版激活名册存储（纯浏览器与单测用）。 */
export function createMemoryChartActivationStore(initial: IndicatorInstance[] = []): ChartActivationStore {
  const map = new Map<string, IndicatorInstance>()
  for (const item of initial) {
    const clean = sanitizeInstance(item)
    if (clean !== undefined) map.set(clean.id, clean)
  }

  return {
    list: async () => [...map.values()].map(instance => sanitizeInstance(instance) as IndicatorInstance),
    activate: async (instance) => {
      const clean = sanitizeInstance(instance)
      if (clean === undefined) {
        const id = (instance as { id?: unknown } | null | undefined)?.id
        throw new Error('chart activation: invalid instance shape for id ' + JSON.stringify(id))
      }
      map.set(clean.id, clean)
    },
    deactivate: async (id) => map.delete(id),
    replaceAll: async (instances) => {
      map.clear()
      for (const item of instances) {
        const clean = sanitizeInstance(item)
        if (clean !== undefined) map.set(clean.id, clean)
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
      return {
        id: record.id,
        title: record.title,
        pane: record.pane,
        params: record.params,
        ...(record.description !== undefined ? { description: record.description } : {}),
      }
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
