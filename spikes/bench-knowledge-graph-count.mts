/** P4 前后对照：buildGraph 默认模式（物化全部边对象） vs countGraphSummary（只计数）。 */
import { buildGraph, countGraphSummary } from '../packages/knowledge/src/graph.ts'
import type { KnowledgeCard } from '../packages/knowledge/src/types.ts'

function makeCard(id: string, author: string, tags: string[], related: string[] = []): KnowledgeCard {
  return {
    id, title: 't-' + id, summary: 's',
    source: { type: 'bilibili', url: 'https://bilibili.com/video/' + id, author, publishedAt: '2026-08-30' },
    credibility: 'high', coreClaims: [], factCheck: { verified: [], discrepancies: [], unverifiable: [] },
    takeaways: [], boundaries: [], tags, related,
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
  }
}
function lib(count: number): KnowledgeCard[] {
  const tags = ['宏观', '行业', '公司', '策略', '风险', '估值', '美债', 'A股', '港股', '加密', '黄金', '原油', '半导体', '医药', '消费']
  const authors = Array.from({ length: 25 }, (_, i) => 'author-' + i)
  return Array.from({ length: count }, (_, i) => {
    const cardTags = [tags[i % tags.length]!, tags[(i * 7 + 3) % tags.length]!]
    const related = i > 0 && i % 5 === 0 ? ['kc_' + ((i * 13) % i)] : []
    return makeCard('kc_' + i, authors[i % authors.length]!, cardTags, related)
  })
}
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
for (const n of [215, 1000, 3000]) {
  const cards = lib(n)
  const check = countGraphSummary(cards)
  const full = buildGraph(cards)
  if (check.nodeCount !== full.nodes.length || check.edgeCount !== full.links.length) throw new Error('MISMATCH')
  const a: number[] = []; const b: number[] = []
  for (let r = 0; r < 7; r++) {
    let t = performance.now(); buildGraph(cards); a.push(performance.now() - t)
    t = performance.now(); countGraphSummary(cards); b.push(performance.now() - t)
  }
  console.log(JSON.stringify({ cards: n, edges: check.edgeCount, buildGraphMs: +median(a).toFixed(2), countMs: +median(b).toFixed(2), speedup: +(median(a) / median(b)).toFixed(1) }))
}
