/**
 * 知识库视图筛选态的校验与固定候选词表（纯函数，视图与单测共用）。
 *
 * 背景：标签 / 作者下拉的候选来自**当前卡片集**（见 KnowledgeView 的 allTags /
 * allAuthors）。持久化的筛选值一旦从候选里消失——典型场景是某个作者的卡片被
 * 全部移出知识库——浏览器会把下拉回落显示成「全部」，但过滤条件仍在执行：
 * 视图显示 0 张卡片，筛选器上却看不出任何生效条件（2026-10-11 实证）。
 * 视图在卡片集就绪后用它挑出失效字段并清空，保持 UI 与过滤条件一致。
 */
import type { KnowledgeLocaleKey } from './contract.ts'

export interface KnowledgeViewFilterValues {
  selectedTag: string
  selectedAuthor: string
  selectedCredibility: string
  selectedSourceType: string
}

export interface KnowledgeFilterCandidates {
  tags: readonly string[]
  authors: readonly string[]
}

export type KnowledgeFilterField = keyof KnowledgeViewFilterValues

/** 可信度下拉的候选（值 + i18n 键，渲染与校验同源）。 */
export const CREDIBILITY_OPTIONS: ReadonlyArray<{ value: string; labelKey: KnowledgeLocaleKey }> = [
  { value: 'high', labelKey: 'kv.credibility.high' },
  { value: 'medium', labelKey: 'kv.credibility.medium' },
  { value: 'low', labelKey: 'kv.credibility.low' },
]

/** 来源平台下拉的候选（值 + i18n 键，渲染与校验同源）。 */
export const SOURCE_TYPE_OPTIONS: ReadonlyArray<{ value: string; labelKey: KnowledgeLocaleKey }> = [
  { value: 'bilibili', labelKey: 'kv.sourceType.bilibili' },
  { value: 'wechat', labelKey: 'kv.sourceType.wechat' },
  { value: 'manual', labelKey: 'kv.sourceType.manual' },
]

/**
 * 挑出候选集里已不存在的筛选字段（保持传入顺序）。
 * 空字符串表示「不过滤」，不是失效值。
 */
export function staleFilterFields(
  values: KnowledgeViewFilterValues,
  candidates: KnowledgeFilterCandidates,
): KnowledgeFilterField[] {
  const stale: KnowledgeFilterField[] = []
  if (values.selectedTag && !candidates.tags.includes(values.selectedTag)) {
    stale.push('selectedTag')
  }
  if (values.selectedAuthor && !candidates.authors.includes(values.selectedAuthor)) {
    stale.push('selectedAuthor')
  }
  const credibility = CREDIBILITY_OPTIONS.map((option) => option.value)
  if (values.selectedCredibility && !credibility.includes(values.selectedCredibility)) {
    stale.push('selectedCredibility')
  }
  const sourceTypes = SOURCE_TYPE_OPTIONS.map((option) => option.value)
  if (values.selectedSourceType && !sourceTypes.includes(values.selectedSourceType)) {
    stale.push('selectedSourceType')
  }
  return stale
}
