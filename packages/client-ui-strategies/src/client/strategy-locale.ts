/**
 * 策略页展示文案的词典查表 helper（PR #56 评审 L7 拆出）：
 * 独立模块切断 ScreenerPane ↔ StrategyView 的模块环（两文件曾互引，
 * 渲染期调用下当前安全，但顶层消费在打包重排下会 TDZ——本仓已有前科
 * d82167a）。同时统一「t 单次调用 + miss 比对回退」形状，消除逐格
 * 2–4 次重复 t() 调用。
 *
 * 键约定 strat.<id>[.summary/.param.<key>/.reason.<kind>]/
 * scr.<id>[.summary/.param.<key>/.col.<key>/.reason]。
 * 词典优先，miss 回退定义自带值——自定义策略（用户 author，单语）自动走回退，
 * host 纯库（packages/strategies）零 locale 依赖。
 */
import type { StrategyLocaleKey } from './contract.ts'

/** 查表 miss 判定：SDK t() 在键缺失时返回 key 本身（契约，见 locale-contract 测试）。 */
function translateOr(
  key: StrategyLocaleKey,
  fallback: string,
  t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string,
  params?: Record<string, unknown>,
): string {
  const translated = t(key, params)
  return translated !== key ? translated : fallback
}

export function strategyName(def: { id: string; name: string }, t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string): string {
  return translateOr(`strat.${def.id}` as StrategyLocaleKey, def.name, t)
}

export function strategySummary(def: { id: string; summary: string }, t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string): string {
  return translateOr(`strat.${def.id}.summary` as StrategyLocaleKey, def.summary, t)
}

export function paramLabel(def: { id: string }, param: { key: string; label: string }, t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string): string {
  return translateOr(`strat.${def.id}.param.${param.key}` as StrategyLocaleKey, param.label, t)
}

export function screenerName(def: { id: string; name: string }, t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string): string {
  return translateOr(def.id as StrategyLocaleKey, def.name, t)
}

export function screenerSummary(def: { id: string; summary: string }, t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string): string {
  return translateOr(`${def.id}.summary` as StrategyLocaleKey, def.summary, t)
}

export function screenerParamLabel(def: { id: string }, param: { key: string; label: string }, t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string): string {
  return translateOr(`${def.id}.param.${param.key}` as StrategyLocaleKey, param.label, t)
}

export function screenerColumnLabel(def: { id: string }, col: { key: string; label: string }, t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string): string {
  return translateOr(`${def.id}.col.${col.key}` as StrategyLocaleKey, col.label, t)
}

/** 选股器命中原因：reasonKey 词典命中（带插值参数）优先，miss 回退 zh 原文。 */
export function screenerReason(
  row: { reason: string; reasonKey?: string; reasonParams?: Readonly<Record<string, string | number>> },
  t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string,
): string {
  if (row.reasonKey === undefined) return row.reason
  return translateOr(row.reasonKey as StrategyLocaleKey, row.reason, t, { ...(row.reasonParams ?? {}) })
}

/** 交易流水的离场原因：词典键优先（内置范式，en 下走当语模板），回退 zh 原文
 *  （自定义策略无 reasonKey）。momentum 的 {cause} 槽是稳定枚举键，先翻译成
 *  当语文案再进模板插值。 */
export function exitReasonText(
  tr: { exitReason: string; exitReasonKey?: string; exitReasonParams?: Readonly<Record<string, string | number>> },
  t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string,
): string {
  if (tr.exitReasonKey === undefined) return tr.exitReason
  const params: Record<string, unknown> = { ...(tr.exitReasonParams ?? {}) }
  if (typeof params.cause === 'string' && ['momentumNegative', 'belowBaseline'].includes(params.cause)) {
    const causeKey = `strat.momentum-12m.cause.${params.cause}` as StrategyLocaleKey
    params.cause = t(causeKey) !== causeKey ? t(causeKey) : params.cause
  }
  return translateOr(tr.exitReasonKey as StrategyLocaleKey, tr.exitReason, t, params)
}