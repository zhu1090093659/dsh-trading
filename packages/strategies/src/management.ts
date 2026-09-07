/**
 * 策略管理名册合成与内置源码导出（策略管理，2026-09-07）。
 *
 * 覆盖 + 墓碑模型的唯一合成逻辑：内置范式（代码常量）为出厂默认层，
 * 自定义 store 中同 id 的记录是覆盖层，墓碑表是删除层。agent 侧
 * （resolveStrategyDefinition）与 GUI 侧（StrategyView）共用本模块，
 * 保证两侧名册一致。纯函数、零 Node 依赖，浏览器安全。
 */
import { strategyParadigms } from './paradigms/index.ts'
import { screenerParadigms } from './screeners/index.ts'
import type { StrategyDefinition, StrategyParamSpec } from './types.ts'
import type { CustomStrategyRecord } from './custom.ts'
import type { ScreenerColumnSpec, ScreenerDefinition } from './screeners/types.ts'
import type { CustomScreenerRecord } from './custom-screener.ts'

/** 内置范式策略 id 集合（稳定词汇；选股器 id 带 'scr.' 前缀，不在此列）。 */
export const BUILTIN_STRATEGY_IDS: ReadonlySet<string> = new Set(strategyParadigms.map((d) => d.id))

/** 内置选股器 id 集合（'scr.' 前缀词汇）。 */
export const BUILTIN_SCREENER_IDS: ReadonlySet<string> = new Set(screenerParadigms.map((d) => d.id))

export function isBuiltinStrategyId(id: string): boolean {
  return BUILTIN_STRATEGY_IDS.has(id)
}

export function isBuiltinScreenerId(id: string): boolean {
  return BUILTIN_SCREENER_IDS.has(id)
}

/**
 * 名册合成：内置 − 墓碑，覆盖记录原位替换同 id 内置，自定义按传入顺序追加。
 * @param paradigms 出厂默认名册（生产传 strategyParadigms，单测可传定制名册）
 * @param defs 自定义 store 校验后的定义（含覆盖内置的同 id 记录）
 * @param deletedIds 墓碑 id（内置删除标记；命中者从名册剔除）
 */
export function applyStrategyManagement(
  paradigms: readonly StrategyDefinition[],
  defs: readonly StrategyDefinition[],
  deletedIds: readonly string[],
): StrategyDefinition[] {
  const deleted = new Set(deletedIds)
  const overrides = new Map<string, StrategyDefinition>()
  const customs: StrategyDefinition[] = []
  for (const def of defs) {
    if (BUILTIN_STRATEGY_IDS.has(def.id)) overrides.set(def.id, def)
    else customs.push(def)
  }
  const roster: StrategyDefinition[] = []
  for (const builtin of paradigms) {
    if (deleted.has(builtin.id)) continue
    roster.push(overrides.get(builtin.id) ?? builtin)
  }
  return [...roster, ...customs]
}

/**
 * 内置策略 compute 源码导出（GUI「编辑内置」预填用）。
 *
 * 前提：内置 compute 一律自包含（指标数学内联，不引用外部闭包），方法速记
 * 形态 `compute(bars, params) { ... }` 归一为箭头形态 `(bars, params) => { ... }`
 * ——后者是 compileStrategySource 直接接受的形状。打包器若改写为箭头/function
 * 形态则原样透传（同样被 compileStrategySource 支持）。
 */
export function builtinStrategySource(def: StrategyDefinition): string {
  const raw = def.compute.toString().trim()
  const method = raw.match(/^compute\s*\(([^)]*)\)\s*\{([\s\S]*)\}$/)
  if (method !== null) return `(${method[1]}) => {${method[2]}}`
  return raw
}

/**
 * 内置策略 → 可编辑记录预填（GUI 编辑器初值）。params 序列化保留 step，
 * 让覆盖保存后参数步进与出厂一致（校验器接受合法 step）。
 */
export function builtinStrategyRecord(def: StrategyDefinition): CustomStrategyRecord {
  const params: StrategyParamSpec[] = def.params.map((p) => ({
    key: p.key, label: p.label, default: p.default, min: p.min, max: p.max, step: p.step,
  }))
  return {
    id: def.id,
    title: def.name,
    horizon: def.horizon,
    summary: def.summary,
    paramsJson: JSON.stringify(params),
    computeSource: builtinStrategySource(def),
    createdAt: Date.now(),
  }
}

/**
 * 选股器名册合成（覆盖 + 墓碑，与 applyStrategyManagement 同模型）：
 * 内置 − 墓碑，覆盖记录原位替换同 id 内置，自定义按传入顺序追加。
 */
export function applyScreenerManagement(
  builtins: readonly ScreenerDefinition[],
  defs: readonly ScreenerDefinition[],
  deletedIds: readonly string[],
): ScreenerDefinition[] {
  const deleted = new Set(deletedIds)
  const overrides = new Map<string, ScreenerDefinition>()
  const customs: ScreenerDefinition[] = []
  for (const def of defs) {
    if (BUILTIN_SCREENER_IDS.has(def.id)) overrides.set(def.id, def)
    else customs.push(def)
  }
  const roster: ScreenerDefinition[] = []
  for (const builtin of builtins) {
    if (deleted.has(builtin.id)) continue
    roster.push(overrides.get(builtin.id) ?? builtin)
  }
  return [...roster, ...customs]
}

/**
 * 内置选股器 evaluate 源码导出（GUI「编辑内置」预填用），归一化规则同
 * builtinStrategySource：方法速记 `evaluate(bars, params) { ... }` → 箭头形态。
 */
export function builtinScreenerSource(def: ScreenerDefinition): string {
  const raw = def.evaluate.toString().trim()
  const method = raw.match(/^evaluate\s*\(([^)]*)\)\s*\{([\s\S]*)\}$/)
  if (method !== null) return `(${method[1]}) => {${method[2]}}`
  return raw
}

/** 内置选股器 → 可编辑记录预填（columns 序列化保真）。 */
export function builtinScreenerRecord(def: ScreenerDefinition): CustomScreenerRecord {
  const params: StrategyParamSpec[] = def.params.map((p) => ({
    key: p.key, label: p.label, default: p.default, min: p.min, max: p.max, step: p.step,
  }))
  const columns: ScreenerColumnSpec[] = def.columns.map((c) => (
    c.format === undefined ? { key: c.key, label: c.label } : { key: c.key, label: c.label, format: c.format }
  ))
  return {
    id: def.id,
    title: def.name,
    horizon: 'swing',
    summary: def.summary,
    paramsJson: JSON.stringify(params),
    columnsJson: JSON.stringify(columns),
    evaluateSource: builtinScreenerSource(def),
    createdAt: Date.now(),
  }
}
