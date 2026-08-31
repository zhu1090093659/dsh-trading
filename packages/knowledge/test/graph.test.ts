import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/graph.ts'
import type { KnowledgeCard } from '../src/types.ts'

function makeCard(id: string, title: string, author: string, tags: string[], related: string[] = []): KnowledgeCard {
  return {
    id,
    title,
    summary: `Summary of ${title}`,
    source: {
      type: 'bilibili',
      url: `https://bilibili.com/video/${id}`,
      author,
      publishedAt: '2026-08-30',
    },
    credibility: 'high',
    coreClaims: ['Claim 1'],
    factCheck: { verified: ['Verified fact'], discrepancies: [], unverifiable: [] },
    takeaways: ['Takeaway 1'],
    boundaries: ['Boundary 1'],
    tags,
    related,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  }
}

describe('Knowledge Graph Builder', () => {
  it('handles empty cards collection', () => {
    const graph = buildGraph([])
    expect(graph.nodes).toHaveLength(0)
    expect(graph.links).toHaveLength(0)
  })

  it('keeps isolated nodes with degree 0', () => {
    const card1 = makeCard('kc_1', '孤立卡片A', '作者A', ['独有标签A'])
    const card2 = makeCard('kc_2', '孤立卡片B', '作者B', ['独有标签B'])
    const graph = buildGraph([card1, card2])

    expect(graph.nodes).toHaveLength(2)
    expect(graph.links).toHaveLength(0)
    expect(graph.nodes[0]?.degree).toBe(0)
    expect(graph.nodes[1]?.degree).toBe(0)
  })

  it('merges multi-tag overlaps into a single co-tag link and accumulates weight', () => {
    const card1 = makeCard('kc_1', '卡片1', '作者A', ['宏观', '利率', '红利'])
    const card2 = makeCard('kc_2', '卡片2', '作者B', ['宏观', '利率', '成长'])
    const graph = buildGraph([card1, card2])

    expect(graph.nodes).toHaveLength(2)
    expect(graph.links).toHaveLength(1)
    const link = graph.links[0]
    expect(link).toBeDefined()
    expect(link?.kind).toBe('co-tag')
    expect(link?.weight).toBe(2) // 共享了 '宏观' 与 '利率' 2 个标签
    expect(graph.nodes[0]?.degree).toBe(1)
    expect(graph.nodes[1]?.degree).toBe(1)
  })

  it('creates related links and co-author links', () => {
    const card1 = makeCard('kc_1', '卡片1', '同名UP主', ['标签A'], ['kc_2'])
    const card2 = makeCard('kc_2', '卡片2', '同名UP主', ['标签B'])
    const graph = buildGraph([card1, card2])

    expect(graph.nodes).toHaveLength(2)
    // 包含 1 条 related 边 + 1 条 co-author 边
    expect(graph.links).toHaveLength(2)
    expect(graph.links.some((l) => l.kind === 'related')).toBe(true)
    expect(graph.links.some((l) => l.kind === 'co-author')).toBe(true)
  })
})
