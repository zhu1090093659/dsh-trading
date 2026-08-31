import { describe, expect, it } from 'vitest'
import { validateKnowledgeCard } from '../src/validate.ts'
import type { KnowledgeCard, KnowledgeCardInput } from '../src/types.ts'

function createSampleCardInput(): KnowledgeCardInput {
  return {
    title: '高股息资产在低利率环境下的防御逻辑',
    summary: '深度解析低利率周期中高股息资产的估值重构与现金流防御壁垒。',
    source: {
      type: 'bilibili',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      author: '硬核财经说',
      publishedAt: '2026-08-28',
    },
    credibility: 'high',
    coreClaims: [
      '无风险利率下行推高股息资产相对吸引力',
      '自由现金流覆盖率是衡量分红可持续性的核心指标',
    ],
    factCheck: {
      verified: ['近三年央企平均分红率超过 45%'],
      discrepancies: [],
      unverifiable: [],
    },
    takeaways: ['关注自由现金流与股息支付率而非仅看静态股息率'],
    boundaries: ['周期性行业盈利大幅下行时可能触发假高股息陷阱'],
    tags: ['宏观', '高股息', '红利策略'],
    tickers: ['600519.SH', '601398.SH'],
  }
}

describe('Knowledge Card Validation', () => {
  it('passes on valid card input and generates id', () => {
    const input = createSampleCardInput()
    const result = validateKnowledgeCard(input)
    expect(result.ok).toBe(true)
    expect(result.card).toBeDefined()
    expect(result.card?.id).toMatch(/^kc_/)
    expect(result.card?.title).toBe(input.title)
    expect(result.card?.createdAt).toBeDefined()
  })

  it('rejects missing title or summary', () => {
    const input = { ...createSampleCardInput(), title: '' }
    const res1 = validateKnowledgeCard(input)
    expect(res1.ok).toBe(false)
    expect(res1.error).toContain('title')

    const input2 = { ...createSampleCardInput(), summary: '   ' }
    const res2 = validateKnowledgeCard(input2)
    expect(res2.ok).toBe(false)
    expect(res2.error).toContain('summary')
  })

  it('rejects invalid source url or type mismatch', () => {
    const input = {
      ...createSampleCardInput(),
      source: {
        type: 'wechat' as const,
        url: 'https://unknown-domain.com/article/123',
        author: '微信公众号',
      },
    }
    const result = validateKnowledgeCard(input)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不匹配或不符合白名单')
  })

  it('rejects invalid credibility level', () => {
    const input = { ...createSampleCardInput(), credibility: 'unknown' as never }
    const result = validateKnowledgeCard(input)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('credibility')
  })

  it('rejects dangling related card IDs', () => {
    const input: KnowledgeCardInput = {
      ...createSampleCardInput(),
      related: ['kc_nonexistent_id'],
    }
    const existingCards: KnowledgeCard[] = []
    const result = validateKnowledgeCard(input, existingCards)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('拒绝悬空关联')
  })

  it('accepts related IDs when they exist in existingCards', () => {
    const existing: KnowledgeCard = {
      ...createSampleCardInput(),
      id: 'kc_existing_123',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }
    const input: KnowledgeCardInput = {
      ...createSampleCardInput(),
      related: ['kc_existing_123'],
    }
    const result = validateKnowledgeCard(input, [existing])
    expect(result.ok).toBe(true)
    expect(result.card?.related).toEqual(['kc_existing_123'])
  })
})
