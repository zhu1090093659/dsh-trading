import { describe, expect, it } from 'vitest'
import { buildGraph, countGraphSummary } from '../src/graph.ts'
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

describe('Knowledge Graph Builder — tagHubs 模式（Obsidian 式）', () => {
  it('creates one hub node per distinct tag and card-tag edges only', () => {
    const card1 = makeCard('kc_1', '卡片1', '作者A', ['宏观', '利率'])
    const card2 = makeCard('kc_2', '卡片2', '作者A', ['宏观', '成长'])
    const graph = buildGraph([card1, card2], { tagHubs: true, coTag: false, coAuthor: false })

    // 2 卡片节点 + 3 个标签 hub（宏观/利率/成长）
    expect(graph.nodes).toHaveLength(5)
    const hubs = graph.nodes.filter((n) => n.type === 'tag')
    expect(new Set(hubs.map((n) => n.label))).toEqual(new Set(['宏观', '利率', '成长']))
    // 边 = 4 条卡-标签边（无 co-tag/co-author 全配对）
    expect(graph.links).toHaveLength(4)
    expect(graph.links.every((l) => l.kind === 'tag-hub')).toBe(true)
    // 宏观 hub 度数 = 2
    const macroHub = hubs.find((n) => n.label === '宏观')
    expect(macroHub?.degree).toBe(2)
  })

  it('keeps explicit related edges in hub mode', () => {
    const card1 = makeCard('kc_1', '卡片1', '作者A', ['宏观'], ['kc_2'])
    const card2 = makeCard('kc_2', '卡片2', '作者A', ['宏观'])
    const graph = buildGraph([card1, card2], { tagHubs: true, coTag: false, coAuthor: false })

    expect(graph.links.some((l) => l.kind === 'related')).toBe(true)
    expect(graph.links.some((l) => l.kind === 'co-author')).toBe(false)
    expect(graph.links.some((l) => l.kind === 'co-tag')).toBe(false)
  })

  it('scales linearly on a single-author large library (no O(n²) blowup)', () => {
    const cards = Array.from({ length: 100 }, (_, i) => makeCard('kc_' + i, '卡' + i, '同一作者', ['主题', '年份']))
    const graph = buildGraph(cards, { tagHubs: true, coTag: false, coAuthor: false })

    // 100 卡 + 2 hub，边 = 200 条卡-标签边；全配对模式下这里会是 4950+ 边
    expect(graph.nodes).toHaveLength(102)
    expect(graph.links).toHaveLength(200)
  })
})

describe('countGraphSummary（knowledge_graph 的只计数通道）', () => {
  // 与默认模式 buildGraph 的 {nodes.length, links.length} 严格同值是硬契约：
  // 用确定性伪随机卡集做等价断言（含多标签重叠/同作者/related 互指/manual 排除）。
  function lcg(seed: number): () => number {
    let s = seed
    return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  }
  function randomCards(seed: number, count: number): KnowledgeCard[] {
    const rand = lcg(seed)
    const tags = ['宏观', '行业', '公司', '策略', '风险', '估值']
    const authors = ['alice', 'bob', 'manual', '手工', '']
    const cards: KnowledgeCard[] = []
    for (let i = 0; i < count; i++) {
      const tagCount = 1 + Math.floor(rand() * 3)
      const cardTags: string[] = []
      for (let t = 0; t < tagCount; t++) cardTags.push(tags[Math.floor(rand() * tags.length)]!)
      const related: string[] = []
      if (i > 0 && rand() < 0.3) related.push('kc_' + Math.floor(rand() * i))
      if (rand() < 0.1) related.push('kc_ghost') // 悬空 related 不入边
      cards.push(makeCard('kc_' + i, '卡' + i, authors[Math.floor(rand() * authors.length)]!, cardTags, related))
    }
    return cards
  }

  it('与 buildGraph 默认模式同值（多组确定性卡集）', () => {
    for (const [seed, count] of [[1, 0], [2, 1], [3, 17], [4, 64], [5, 215]] as const) {
      const cards = randomCards(seed, count)
      const summary = countGraphSummary(cards)
      const graph = buildGraph(cards)
      expect(summary.nodeCount).toBe(graph.nodes.length)
      expect(summary.edgeCount).toBe(graph.links.length)
    }
  })

  it('空库/自指 related/重复标签的边角与 buildGraph 一致', () => {
    expect(countGraphSummary([])).toEqual({ nodeCount: 0, edgeCount: 0 })
    const tricky = [
      makeCard('a', 'A', 'alice', ['x', 'x', 'y'], ['a', 'b']),
      makeCard('b', 'B', 'alice', ['y'], ['a']),
    ]
    const summary = countGraphSummary(tricky)
    const graph = buildGraph(tricky)
    expect(summary).toEqual({ nodeCount: graph.nodes.length, edgeCount: graph.links.length })
  })
})