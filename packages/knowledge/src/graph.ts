/**
 * 知识图谱构建纯函数（对齐 docs/design/knowledge-graph.md §3）。
 *
 * 接收卡片集合，输出解耦的图结构 { nodes, links }。
 * 孤立节点保留（度为 0），多 tag 共享边合并并累加 weight。
 */
import type {
  BuildGraphOptions,
  KnowledgeCard,
  KnowledgeGraphData,
  KnowledgeGraphLink,
  KnowledgeGraphNode,
} from './types.ts'

export function buildGraph(
  cards: readonly KnowledgeCard[],
  options: BuildGraphOptions = {},
): KnowledgeGraphData {
  const { coTag = true, coAuthor = true } = options

  if (!cards || cards.length === 0) {
    return { nodes: [], links: [] }
  }

  const cardMap = new Map<string, KnowledgeCard>()
  for (const c of cards) {
    cardMap.set(c.id, c)
  }

  // 记录无向边的唯一 key -> KnowledgeGraphLink
  const linkMap = new Map<string, KnowledgeGraphLink>()

  function makeLinkKey(id1: string, id2: string, kind: string): string {
    const [a, b] = id1 < id2 ? [id1, id2] : [id2, id1]
    return `${kind}:${a}:${b}`
  }

  // 1. 显式 related 关联边
  for (const card of cards) {
    if (card.related && Array.isArray(card.related)) {
      for (const targetId of card.related) {
        if (cardMap.has(targetId) && targetId !== card.id) {
          const key = makeLinkKey(card.id, targetId, 'related')
          if (!linkMap.has(key)) {
            const [source, target] = card.id < targetId ? [card.id, targetId] : [targetId, card.id]
            linkMap.set(key, {
              source,
              target,
              kind: 'related',
              weight: 2, // 显式关联给予更高基准权重
            })
          }
        }
      }
    }
  }

  // 2. 共享 tag (co-tag) 关联边
  if (coTag) {
    for (let i = 0; i < cards.length; i++) {
      const cardA = cards[i]
      const tagsA = new Set(cardA.tags)

      for (let j = i + 1; j < cards.length; j++) {
        const cardB = cards[j]
        let sharedTagCount = 0
        for (const t of cardB.tags) {
          if (tagsA.has(t)) {
            sharedTagCount++
          }
        }

        if (sharedTagCount > 0) {
          const key = makeLinkKey(cardA.id, cardB.id, 'co-tag')
          const [source, target] = cardA.id < cardB.id ? [cardA.id, cardB.id] : [cardB.id, cardA.id]
          linkMap.set(key, {
            source,
            target,
            kind: 'co-tag',
            weight: sharedTagCount,
          })
        }
      }
    }
  }

  // 3. 同作者 (co-author) 关联边
  if (coAuthor) {
    for (let i = 0; i < cards.length; i++) {
      const cardA = cards[i]
      const authorA = cardA.source.author.trim()
      if (!authorA || authorA === 'manual' || authorA === '手工') continue

      for (let j = i + 1; j < cards.length; j++) {
        const cardB = cards[j]
        const authorB = cardB.source.author.trim()
        if (authorA === authorB) {
          const key = makeLinkKey(cardA.id, cardB.id, 'co-author')
          const [source, target] = cardA.id < cardB.id ? [cardA.id, cardB.id] : [cardB.id, cardA.id]
          linkMap.set(key, {
            source,
            target,
            kind: 'co-author',
            weight: 1,
          })
        }
      }
    }
  }

  const links = Array.from(linkMap.values())

  // 4. 统计各节点度数 (degree)
  const degreeMap = new Map<string, number>()
  for (const c of cards) {
    degreeMap.set(c.id, 0)
  }
  for (const l of links) {
    degreeMap.set(l.source, (degreeMap.get(l.source) ?? 0) + 1)
    degreeMap.set(l.target, (degreeMap.get(l.target) ?? 0) + 1)
  }

  // 5. 构造节点
  const nodes: KnowledgeGraphNode[] = cards.map((card) => ({
    id: card.id,
    label: card.title,
    cluster: card.tags[0] ?? '未分类',
    credibility: card.credibility,
    degree: degreeMap.get(card.id) ?? 0,
    raw: card,
  }))

  return { nodes, links }
}
