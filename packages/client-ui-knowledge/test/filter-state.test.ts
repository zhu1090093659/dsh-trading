/**
 * 筛选态校验的纯逻辑单测。视图挂载时的清空动作与下拉回落行为依赖真实宿主，
 * 由 trading-web profile 的实机验证覆盖（见 docs/design/knowledge-graph.md §5）。
 */
import { describe, expect, it } from 'vitest'
import {
  CREDIBILITY_OPTIONS,
  SOURCE_TYPE_OPTIONS,
  staleFilterFields,
} from '../src/client/filter-state.ts'

const NO_FILTER = {
  selectedTag: '',
  selectedAuthor: '',
  selectedCredibility: '',
  selectedSourceType: '',
}

describe('知识库视图筛选态校验', () => {
  it('用户遇到某作者卡片被整体移出时，该作者筛选值被判为失效', () => {
    // Given: 持久化里留着已从卡片集消失的作者
    const values = { ...NO_FILTER, selectedAuthor: '艾丽的无废话财经' }
    // When: 用当前卡片集的作者候选校验
    const stale = staleFilterFields(values, {
      tags: ['美元体系2.0与货币体系'],
      authors: ['鳄鱼派（像鳄鱼一样思考）', '火星船长1989'],
    })
    // Then: 只有作者字段需要清空
    expect(stale).toEqual(['selectedAuthor'])
  })

  it('用户遇到某标签的卡片被清空时，该标签筛选值被判为失效', () => {
    // Given: 持久化的标签已不在当前候选集里
    const values = { ...NO_FILTER, selectedTag: '地缘博弈' }
    // When: 用当前卡片集的标签候选校验
    const stale = staleFilterFields(values, { tags: ['鳄鱼派交易方法'], authors: [] })
    // Then: 只有标签字段需要清空
    expect(stale).toEqual(['selectedTag'])
  })

  it('用户筛选值仍在候选集里时，不做任何清空', () => {
    // Given: 持久化的作者与标签都仍然存在
    const values = {
      ...NO_FILTER,
      selectedTag: '鳄鱼派交易方法',
      selectedAuthor: '鳄鱼派（像鳄鱼一样思考）',
      selectedCredibility: 'medium',
      selectedSourceType: 'bilibili',
    }
    // When: 用包含两者的候选集校验
    const stale = staleFilterFields(values, {
      tags: ['鳄鱼派交易方法'],
      authors: ['鳄鱼派（像鳄鱼一样思考）'],
    })
    // Then: 没有失效字段，用户的筛选保持不变
    expect(stale).toEqual([])
  })

  it('用户未设置任何筛选时，空值不被当成失效值', () => {
    // Given: 全新会话的空筛选态
    const values = { ...NO_FILTER }
    // When: 用空候选集校验
    const stale = staleFilterFields(values, { tags: [], authors: [] })
    // Then: 空字符串表示「不过滤」，不产生清空动作
    expect(stale).toEqual([])
  })

  it('用户遇到固定词表外的评级或平台值时，两个字段都被判为失效且顺序稳定', () => {
    // Given: 持久化的评级与平台都不在下拉的固定候选里
    const values = {
      ...NO_FILTER,
      selectedTag: '已消失的标签',
      selectedAuthor: '已消失的作者',
      selectedCredibility: 'unknown',
      selectedSourceType: 'podcast',
    }
    // When: 用当前候选集校验
    const stale = staleFilterFields(values, { tags: [], authors: [] })
    // Then: 四个字段按标签 → 作者 → 评级 → 平台的顺序返回
    expect(stale).toEqual([
      'selectedTag',
      'selectedAuthor',
      'selectedCredibility',
      'selectedSourceType',
    ])
  })

  it('用户看到的评级与平台下拉候选与校验用词表同源', () => {
    // Given: 渲染下拉用的候选常量
    // When: 取出其中的取值
    const credibility = CREDIBILITY_OPTIONS.map((option) => option.value)
    const sourceTypes = SOURCE_TYPE_OPTIONS.map((option) => option.value)
    // Then: 取值就是知识库既有的评级与平台词表（渲染与校验不会漂移）
    expect(credibility).toEqual(['high', 'medium', 'low'])
    expect(sourceTypes).toEqual(['bilibili', 'wechat', 'manual'])
  })
})
