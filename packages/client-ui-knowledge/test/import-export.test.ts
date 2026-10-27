/**
 * 知识库导入 / 导出纯函数单测（不引 react-dom：文件名、文本、摘要、解析包装都是纯函数）。
 *
 * 视图侧行为（下载、面板、Esc、写库后重拉）依赖真实宿主与浏览器能力，由
 * trading-web profile 的实机验证覆盖；这里只钉住「文本与计数」这一层事实。
 */
import { describe, expect, it } from 'vitest'
import { parseKnowledgeBundle, planKnowledgeImport, type KnowledgeCard } from '@dshtrading/knowledge'
import {
  exportKnowledgeFileName,
  exportKnowledgeText,
  importPlanSummary,
  parseImportFileText,
} from '../src/client/import-export.ts'

function makeCard(input: { id: string; url: string; title: string }): KnowledgeCard {
  return {
    id: input.id,
    title: input.title,
    summary: `${input.title} 的摘要`,
    source: { type: 'manual', url: input.url, author: '鳄鱼派' },
    credibility: 'high',
    coreClaims: [`${input.title} 的核心论点`],
    factCheck: { verified: [], discrepancies: [], unverifiable: [] },
    takeaways: [],
    boundaries: [],
    tags: ['美元体系'],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
}

const LOCAL_CARD = makeCard({ id: 'kc_local_a', url: 'https://example.com/a', title: '美元体系' })
const INCOMING_SAME_URL = makeCard({ id: 'kc_bundle_a', url: 'https://example.com/a', title: '美元体系（对方库）' })
const INCOMING_NEW = {
  ...makeCard({ id: 'kc_new_b', url: 'https://example.com/b', title: '实际利率' }),
  related: ['kc_missing'],
}
const INCOMING_INVALID = { ...makeCard({ id: 'kc_bad_c', url: 'https://example.com/c', title: '无标签卡' }), tags: [] }

describe('知识库导入 / 导出纯函数', () => {
  it('用户导出知识库时文件名带本地时间戳且各段补零', () => {
    // Given: 本地时间 2026-11-09 08:05:03（月/日/时分秒都需要补零）
    const now = new Date(2026, 10, 9, 8, 5, 3)
    // When: 生成导出文件名
    const name = exportKnowledgeFileName(now)
    // Then: 固定格式 knowledge-YYYYMMDD-HHmmss.json
    expect(name).toBe('knowledge-20261109-080503.json')
  })

  it('客户拿到的导出文件能被同一套解析器原样读回', () => {
    // Given: 库里两张卡片与一个固定导出时刻
    const cards = [LOCAL_CARD, makeCard({ id: 'kc_local_b', url: 'https://example.com/b', title: '实际利率' })]
    const now = new Date(2026, 10, 9, 8, 5, 3)
    // When: 导出文本再用视图同款解析入口读回
    const parsed = parseImportFileText(exportKnowledgeText(cards, now))
    // Then: 解析成功且卡片 id 与导出前一致
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bundle.cards.map((card) => card.id)).toEqual(['kc_local_a', 'kc_local_b'])
  })

  it('访客导出空知识库时得到可再次导入的空 bundle', () => {
    // Given: 空卡片集合（空库也要能导出）
    // When: 导出并读回
    const parsed = parseImportFileText(exportKnowledgeText([], new Date(2026, 10, 9, 8, 5, 3)))
    // Then: 仍是合法 bundle，卡片数为 0
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bundle.cards).toHaveLength(0)
  })

  it('运营在跳过模式下看到新增、跳过、丢弃关联、非法四个非零计数', () => {
    // Given: 本机已有同来源链接的卡片，导入文件含同链接卡、新卡（带悬空关联）与一张无标签卡
    // When: 用跳过模式算计划摘要
    const summary = importPlanSummary(
      planKnowledgeImport([LOCAL_CARD], [INCOMING_SAME_URL, INCOMING_NEW, INCOMING_INVALID], 'skip'),
    )
    // Then: 新卡新增、同链接卡跳过、悬空关联记一条丢弃、无标签卡判非法
    expect(summary).toEqual({ create: 1, update: 0, skip: 1, dropped: 1, invalid: 1 })
  })

  it('管理员切到覆盖模式后同一批文件改为更新同链接卡片', () => {
    // Given: 与本机同来源链接的卡片仍保留在导入文件里
    // When: 用覆盖模式算计划摘要
    const summary = importPlanSummary(
      planKnowledgeImport([LOCAL_CARD], [INCOMING_SAME_URL, INCOMING_NEW, INCOMING_INVALID], 'overwrite'),
    )
    // Then: 同链接卡从「跳过」移到「更新」，其余计数不变
    expect(summary).toEqual({ create: 1, update: 1, skip: 0, dropped: 1, invalid: 1 })
  })

  it('用户选到非法文件时拿到解析器的原文错误', () => {
    // Given: 一份不是 JSON 的文件文本
    const text = 'not a json file'
    // When: 走视图同款解析入口，并与解析器直接调用对比
    const wrapped = parseImportFileText(text)
    // Then: 失败并原样透传解析器给的错误文本
    expect(wrapped).toEqual(parseKnowledgeBundle(text))
    expect(wrapped.ok).toBe(false)
    if (wrapped.ok) return
    expect(wrapped.error).toContain('不是合法 JSON')
  })
})
