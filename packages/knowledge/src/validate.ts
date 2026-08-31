/**
 * 知识卡片摄取结构校验器（对齐 docs/design/knowledge-graph.md §4）。
 *
 * 纯函数、无副作用、浏览器与 Node 端同构。
 */
import type { KnowledgeCard, KnowledgeCardInput, KnowledgeCredibility, KnowledgeSourceType } from './types.ts'

const ALLOWED_CREDIBILITY = new Set<KnowledgeCredibility>(['high', 'medium', 'low'])
const ALLOWED_SOURCE_TYPES = new Set<KnowledgeSourceType>(['bilibili', 'wechat', 'manual'])

export interface ValidationResult {
  ok: boolean
  card?: KnowledgeCard
  error?: string
}

function isValidSourceUrl(url: string, type: KnowledgeSourceType): boolean {
  if (!url || typeof url !== 'string') return false
  const trimmed = url.trim()
  if (type === 'manual') {
    return trimmed === 'manual' || trimmed.startsWith('manual:') || trimmed.startsWith('http://') || trimmed.startsWith('https://')
  }
  if (type === 'bilibili') {
    return trimmed.includes('bilibili.com') || trimmed.includes('b23.tv') || trimmed.startsWith('BV')
  }
  if (type === 'wechat') {
    return trimmed.includes('mp.weixin.qq.com') || trimmed.includes('weixin.qq.com')
  }
  return true
}

export function generateCardId(): string {
  const timePart = Date.now().toString(36)
  const randPart = Math.random().toString(36).slice(2, 8)
  return `kc_${timePart}${randPart}`
}

export function validateKnowledgeCard(
  input: KnowledgeCardInput,
  existingCards: readonly KnowledgeCard[] = [],
): ValidationResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: '输入卡片数据必须是非空对象' }
  }

  // 1. 标题与摘要
  if (!input.title || typeof input.title !== 'string' || input.title.trim().length === 0) {
    return { ok: false, error: '卡片标题 (title) 为必填字段且不能为空' }
  }
  if (!input.summary || typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    return { ok: false, error: '卡片概述 (summary) 为必填字段且不能为空' }
  }

  // 2. 来源信息校验
  if (!input.source || typeof input.source !== 'object') {
    return { ok: false, error: '卡片来源 (source) 为必填对象' }
  }
  const { type, url, author } = input.source
  if (!type || !ALLOWED_SOURCE_TYPES.has(type)) {
    return { ok: false, error: `来源类型 (source.type) 非法，允许值为: ${Array.from(ALLOWED_SOURCE_TYPES).join(', ')}` }
  }
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return { ok: false, error: '来源链接 (source.url) 为必填字段且不能为空' }
  }
  if (!isValidSourceUrl(url, type)) {
    return { ok: false, error: `来源链接 (source.url) 与来源类型 (${type}) 不匹配或不符合白名单规范` }
  }
  if (!author || typeof author !== 'string' || author.trim().length === 0) {
    return { ok: false, error: '来源作者/UP主/公众号 (source.author) 为必填字段' }
  }

  // 3. 可信度枚举
  if (!input.credibility || !ALLOWED_CREDIBILITY.has(input.credibility)) {
    return { ok: false, error: `内容可信度 (credibility) 非法，允许值为: ${Array.from(ALLOWED_CREDIBILITY).join(', ')}` }
  }

  // 4. 论点、核查、经验与边界列表
  if (!Array.isArray(input.coreClaims) || input.coreClaims.length === 0) {
    return { ok: false, error: '核心论点 (coreClaims) 必须是非空字符串数组' }
  }
  if (!input.factCheck || typeof input.factCheck !== 'object') {
    return { ok: false, error: '事实核查三桶 (factCheck) 为必填对象，包含 verified, discrepancies, unverifiable' }
  }
  const { verified = [], discrepancies = [], unverifiable = [] } = input.factCheck
  if (!Array.isArray(verified) || !Array.isArray(discrepancies) || !Array.isArray(unverifiable)) {
    return { ok: false, error: '事实核查分类项 (verified / discrepancies / unverifiable) 必须为数组' }
  }

  if (!Array.isArray(input.takeaways)) {
    return { ok: false, error: '可复用经验 (takeaways) 必须为字符串数组' }
  }
  if (!Array.isArray(input.boundaries)) {
    return { ok: false, error: '适用边界与避坑 (boundaries) 必须为字符串数组' }
  }
  if (!Array.isArray(input.tags) || input.tags.length === 0) {
    return { ok: false, error: '主题关键词标签 (tags) 必须包含至少一个标签' }
  }

  // 5. related 存在性校验（拒绝悬空 id）
  if (input.related && Array.isArray(input.related) && input.related.length > 0) {
    const existingIds = new Set(existingCards.map((c) => c.id))
    for (const relId of input.related) {
      if (!existingIds.has(relId)) {
        return { ok: false, error: `显式关联卡片 id [${relId}] 在知识库中不存在（拒绝悬空关联）` }
      }
    }
  }

  // 6. 构造规范化 KnowledgeCard
  const now = new Date().toISOString()
  const id = input.id && input.id.startsWith('kc_') ? input.id : generateCardId()
  const createdAt = input.createdAt || now
  const updatedAt = now

  const card: KnowledgeCard = {
    id,
    title: input.title.trim(),
    summary: input.summary.trim(),
    source: {
      type: input.source.type,
      url: input.source.url.trim(),
      author: input.source.author.trim(),
      publishedAt: input.source.publishedAt,
    },
    credibility: input.credibility,
    coreClaims: input.coreClaims.map((c) => String(c).trim()).filter(Boolean),
    factCheck: {
      verified: verified.map((c) => String(c).trim()).filter(Boolean),
      discrepancies: discrepancies.map((c) => String(c).trim()).filter(Boolean),
      unverifiable: unverifiable.map((c) => String(c).trim()).filter(Boolean),
    },
    takeaways: input.takeaways.map((c) => String(c).trim()).filter(Boolean),
    boundaries: input.boundaries.map((c) => String(c).trim()).filter(Boolean),
    tags: input.tags.map((t) => String(t).trim()).filter(Boolean),
    tickers: input.tickers ? input.tickers.map((t) => String(t).trim().toUpperCase()).filter(Boolean) : undefined,
    related: input.related ? Array.from(new Set(input.related)) : undefined,
    createdAt,
    updatedAt,
  }

  return { ok: true, card }
}
