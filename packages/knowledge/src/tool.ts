/**
 * 知识库 Agent 工具（对齐 docs/design/knowledge-graph.md §4 与 dsh-tools 规范）。
 *
 * 包含：
 *   - knowledge_ingest: 结构校验 + URL 查重 Update / Create
 *   - knowledge_search: 跨字段检索（相关度排序）+ 多维过滤 + detail=full 全文返回
 *   - knowledge_get:    按 id 读取单张卡片全文
 *   - knowledge_delete: 证伪下架（删除卡片并清理 related 悬空引用）
 *   - knowledge_export: 按检索同款过滤导出单文件 JSON bundle
 *   - knowledge_import: bundle 先算计划（预览）再写库，source.url 去重
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import os from 'node:os'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dshHomeDir } from '@dshtrading/dsh-home'
import { validateKnowledgeCard } from './validate.ts'
import { createFileKnowledgeCardStore } from './knowledge-fs.ts'
import {
  createKnowledgeBundle,
  parseKnowledgeBundle,
  planKnowledgeImport,
  serializeKnowledgeBundle,
  type KnowledgeImportMode,
} from './bundle.ts'
import type {
  KnowledgeCard,
  KnowledgeCardInput,
  KnowledgeCardStore,
  KnowledgeCredibility,
  KnowledgeSourceType,
} from './types.ts'

export { createFileKnowledgeCardStore }

/** 卡片全文的统一文本渲染（knowledge_get 与 knowledge_search detail=full 共用）。 */
function renderCardFullLines(card: KnowledgeCard): string[] {
  const lines: string[] = []
  if (card.coreClaims.length > 0) lines.push(`  核心论点: ${card.coreClaims.join('；')}`)
  const fc = card.factCheck
  const fcParts: string[] = []
  if (fc.verified.length > 0) fcParts.push(`证实: ${fc.verified.join('；')}`)
  if (fc.discrepancies.length > 0) fcParts.push(`有出入: ${fc.discrepancies.join('；')}`)
  if (fc.unverifiable.length > 0) fcParts.push(`无法核实: ${fc.unverifiable.join('；')}`)
  if (fcParts.length > 0) lines.push(`  事实核查: ${fcParts.join(' | ')}`)
  if (card.takeaways.length > 0) lines.push(`  可复用经验: ${card.takeaways.join('；')}`)
  if (card.boundaries.length > 0) lines.push(`  适用边界: ${card.boundaries.join('；')}`)
  if (card.tickers && card.tickers.length > 0) lines.push(`  关联标的: ${card.tickers.join(', ')}`)
  return lines
}

export interface KnowledgeIngestToolOptions {
  /** 可选：卡片成功落盘后的回调（issue #30：事件总线 emit('knowledge') 的接线点）。 */
  onWritten?: (card: KnowledgeCard) => void
}

/** 时间字段的可读回显：空值/缺省一律写「未知」，不留空位冒充有日期。 */
function shownTimestamp(value: string | undefined): string {
  return value !== undefined && value.trim().length > 0 ? value : '未知'
}

/** 解析显式时效筛选的 ISO 日期：空值表示不筛，非法值抛错由工具回显而不是静默当无命中。 */
function parseCutoff(value: unknown, field: string): number | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) throw new Error(`[knowledge_search] 参数 ${field} 不是合法日期: ${trimmed}`)
  return ms
}

export function createKnowledgeIngestTool(store: KnowledgeCardStore, options: KnowledgeIngestToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'knowledge_ingest',
    description:
      'Ingest one fact-checked knowledge card (a Content Insight product) into the local knowledge base. '
      + 'Duplicate source URLs are detected automatically: an existing card with the same URL is updated in place and keeps its id. '
      + 'Related-card references are validated.',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Card subject, e.g. the defensive logic of high-dividend strategies in a low-rate environment.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'One-sentence overview merging the 2-4 core claims; shown in the graph hover and quick read.',
      },
      sourceType: {
        type: 'string',
        required: true,
        description: 'Source kind: "bilibili" | "wechat" | "manual".',
      },
      sourceUrl: {
        type: 'string',
        required: true,
        description: 'Source link or dedup key, e.g. a Bilibili BV link or a WeChat article link.',
      },
      sourceAuthor: {
        type: 'string',
        required: true,
        description: 'Source author, channel or account name.',
      },
      publishedAt: {
        type: 'string',
        description: 'Optional source publish date, ISO format such as 2026-08-30.',
      },
      credibility: {
        type: 'string',
        required: true,
        description: 'Overall fact-check grade: "high" | "medium" | "low".',
      },
      coreClaimsJson: {
        type: 'json',
        required: true,
        description: 'JSON array of core claims (also accepted as a JSON string), preserving the author\'s reasoning chain, e.g. \'["claim1", "claim2"]\'.',
      },
      factCheckJson: {
        type: 'json',
        required: true,
        description: 'JSON object with the three fact-check buckets (also accepted as a JSON string), e.g. \'{"verified":["..."],"discrepancies":["..."],"unverifiable":[]}\'.',
      },
      takeawaysJson: {
        type: 'json',
        description: 'Optional JSON array of reusable analysis frameworks and lessons (also accepted as a JSON string).',
      },
      boundariesJson: {
        type: 'json',
        description: 'Optional JSON array of applicability boundaries, invalidation cases and pitfalls (also accepted as a JSON string).',
      },
      tagsJson: {
        type: 'json',
        required: true,
        description: 'JSON array of controlled topic tags (also accepted as a JSON string), e.g. \'["宏观", "高股息", "红利策略"]\'.',
      },
      tickersJson: {
        type: 'json',
        description: 'Optional JSON array of related instrument codes (also accepted as a JSON string), e.g. \'["BTCUSDT", "600519.SH"]\'.',
      },
      relatedJson: {
        type: 'json',
        description: 'Optional JSON array of related card ids already in the library (also accepted as a JSON string), e.g. \'["kc_01j...", "kc_01k..."]\'.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>

      function parseJsonArray(val: unknown, fieldName: string, required = false): string[] {
        if (!val) return []
        if (Array.isArray(val)) return val.map(String)
        if (typeof val === 'string') {
          try {
            const parsed = JSON.parse(val)
            if (Array.isArray(parsed)) return parsed.map(String)
          } catch {
            throw new Error(`[knowledge_ingest] 参数 ${fieldName} 不是合法的 JSON 数组: ${val}`)
          }
        }
        if (required) throw new Error(`[knowledge_ingest] 参数 ${fieldName} 必须为字符串数组`)
        return []
      }

      function parseJsonObject(val: unknown, fieldName: string): Record<string, any> {
        if (!val) return {}
        if (typeof val === 'object' && !Array.isArray(val)) return val as Record<string, any>
        if (typeof val === 'string') {
          try {
            const parsed = JSON.parse(val)
            if (typeof parsed === 'object' && parsed !== null) return parsed
          } catch {
            throw new Error(`[knowledge_ingest] 参数 ${fieldName} 不是合法的 JSON 对象: ${val}`)
          }
        }
        return {}
      }

      let coreClaims: string[] = []
      let factCheck: any = { verified: [], discrepancies: [], unverifiable: [] }
      let takeaways: string[] = []
      let boundaries: string[] = []
      let tags: string[] = []
      let tickers: string[] | undefined
      let related: string[] | undefined

      try {
        coreClaims = parseJsonArray(args.coreClaimsJson, 'coreClaimsJson', true)
        factCheck = parseJsonObject(args.factCheckJson, 'factCheckJson')
        takeaways = parseJsonArray(args.takeawaysJson, 'takeawaysJson')
        boundaries = parseJsonArray(args.boundariesJson, 'boundariesJson')
        tags = parseJsonArray(args.tagsJson, 'tagsJson', true)
        tickers = args.tickersJson ? parseJsonArray(args.tickersJson, 'tickersJson') : undefined
        related = args.relatedJson ? parseJsonArray(args.relatedJson, 'relatedJson') : undefined
      } catch (err: any) {
        return `[knowledge_ingest] 参数解析失败: ${err.message}`
      }

      const cardInput: KnowledgeCardInput = {
        title: typeof args.title === 'string' ? args.title : '',
        summary: typeof args.summary === 'string' ? args.summary : '',
        source: {
          type: (args.sourceType as KnowledgeSourceType) || 'manual',
          url: typeof args.sourceUrl === 'string' ? args.sourceUrl : '',
          author: typeof args.sourceAuthor === 'string' ? args.sourceAuthor : '',
          publishedAt: typeof args.publishedAt === 'string' ? args.publishedAt : undefined,
        },
        credibility: (args.credibility as KnowledgeCredibility) || 'high',
        coreClaims,
        factCheck: {
          verified: Array.isArray(factCheck.verified) ? factCheck.verified.map(String) : [],
          discrepancies: Array.isArray(factCheck.discrepancies) ? factCheck.discrepancies.map(String) : [],
          unverifiable: Array.isArray(factCheck.unverifiable) ? factCheck.unverifiable.map(String) : [],
        },
        takeaways,
        boundaries,
        tags,
        tickers,
        related,
      }

      const existingList = await store.list()
      const existingByUrl = await store.getByUrl(cardInput.source.url)

      const inputToValidate: KnowledgeCardInput = {
        ...cardInput,
        id: existingByUrl?.id,
        createdAt: existingByUrl?.createdAt,
      }

      const validation = validateKnowledgeCard(inputToValidate, existingList)
      if (!validation.ok || !validation.card) {
        return `[knowledge_ingest] 知识卡片校验失败: ${validation.error ?? '未知校验错误'}`
      }

      const card = validation.card
      await store.save(card)
      onWritten?.(card)

      const isUpdate = !!existingByUrl
      const actionDesc = isUpdate ? '成功更新已有知识卡片' : '成功创建新知识卡片'
      // 作者别名归一（authors.ts）：入库值被改写时必须回显，避免调用方以为存了原写法。
      const requestedAuthor = typeof args.sourceAuthor === 'string' ? args.sourceAuthor.trim() : ''
      const authorNote = requestedAuthor !== '' && requestedAuthor !== card.source.author
        ? `（作者已归一：${requestedAuthor} → ${card.source.author}）`
        : ''
      return `[knowledge_ingest] ${actionDesc} [${card.id}] "${card.title}"${authorNote} (标签: ${card.tags.join(', ')}${card.related?.length ? `, 关联: ${card.related.join(', ')}` : ''})`
    },
  })
}

export function createKnowledgeSearchTool(store: KnowledgeCardStore) {
  return defineTool({
    name: 'knowledge_search',
    description:
      'Search knowledge cards in the local library. With a keyword the results rank by field hit weight (tags > title > core claims > '
      + 'summary/author); without one they come newest-updated first. Filters: cluster (the graph clustering key, pair with '
      + 'knowledge_graph for two-stage retrieval), author, source kind, credibility and explicit freshness cutoffs updatedAfter / '
      + 'publishedAfter. Every result reports its updatedAt and source publish date (unknown is stated as such); cards are never '
      + 'dropped or downgraded by age unless an explicit cutoff asks for it. detail="full" also returns core claims, the fact-check '
      + 'buckets and reusable lessons (capped at 20 cards).',
    parameters: {
      query: {
        type: 'string',
        description: 'Search keyword, fuzzy-matched against title, summary, core claims and tags.',
      },
      tags: {
        type: 'string',
        description: 'Comma-separated tag filter, e.g. "宏观,高股息"; matches any one of them.',
      },
      cluster: {
        type: 'string',
        description: 'Exact subject filter (subject = graph clustering key = the card first tag). Second stage of a two-stage retrieval: call knowledge_graph for the subject distribution, then drill in here.',
      },
      author: {
        type: 'string',
        description: 'Author/channel filter (substring match).',
      },
      sourceType: {
        type: 'string',
        description: 'Source kind filter: "bilibili" | "wechat" | "manual".',
      },
      credibility: {
        type: 'string',
        description: 'Credibility filter: "high" | "medium" | "low".',
      },
      updatedAfter: {
        type: 'string',
        description: 'Explicit freshness cutoff: keep only cards updated at or after this ISO date/datetime (e.g. "2026-01-01" or "2026-01-01T00:00:00Z"). Cards with an unparsable updatedAt never match. Omitting it applies no age filter.',
      },
      publishedAfter: {
        type: 'string',
        description: 'Explicit freshness cutoff on the source publish date: keep only cards whose source.publishedAt is at or after this ISO date. Cards without a source publish date never match an explicit cutoff (unknown is not assumed fresh).',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return (default 20).',
        default: 20,
      },
      detail: {
        type: 'string',
        description: 'Detail level: "summary" (default) | "full" (adds core claims, fact check, lessons and boundaries).',
        default: 'summary',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const params = (raw ?? {}) as {
        query?: unknown
        tags?: unknown
        cluster?: unknown
        author?: unknown
        sourceType?: unknown
        credibility?: unknown
        updatedAfter?: unknown
        publishedAfter?: unknown
        limit?: unknown
        detail?: unknown
      }

      const allCards = await store.list()
      const queryLower = typeof params.query === 'string' ? params.query.trim().toLowerCase() : ''
      const authorLower = typeof params.author === 'string' ? params.author.trim().toLowerCase() : ''
      const rawTags = typeof params.tags === 'string' ? params.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : []
      const targetCluster = typeof params.cluster === 'string' ? params.cluster.trim().toLowerCase() : ''
      const targetSourceType = typeof params.sourceType === 'string' ? params.sourceType.trim() : undefined
      const targetCredibility = typeof params.credibility === 'string' ? params.credibility.trim() : undefined
      let updatedAfterMs: number | undefined
      let publishedAfterMs: number | undefined
      try {
        updatedAfterMs = parseCutoff(params.updatedAfter, 'updatedAfter')
        publishedAfterMs = parseCutoff(params.publishedAfter, 'publishedAfter')
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(params.limit, 100)) : 20
      const detail = params.detail === 'full' ? 'full' : 'summary'
      // detail=full 时单卡输出约 1-2KB：上限收口到 20，避免一次调用向上下文倾倒百卡全文。
      const effectiveLimit = detail === 'full' ? Math.min(limit, 20) : limit

      const matched = allCards.filter((card) => {
        if (targetSourceType && card.source.type !== targetSourceType) {
          return false
        }
        if (targetCredibility && card.credibility !== targetCredibility) {
          return false
        }
        if (updatedAfterMs !== undefined) {
          const updatedAtMs = Date.parse(card.updatedAt)
          if (Number.isNaN(updatedAtMs) || updatedAtMs < updatedAfterMs) return false
        }
        if (publishedAfterMs !== undefined) {
          const publishedAt = card.source.publishedAt
          const publishedAtMs = publishedAt === undefined ? Number.NaN : Date.parse(publishedAt)
          if (Number.isNaN(publishedAtMs) || publishedAtMs < publishedAfterMs) return false
        }
        if (targetCluster && (card.tags[0] ?? '').trim().toLowerCase() !== targetCluster) {
          return false
        }
        if (authorLower && !card.source.author.toLowerCase().includes(authorLower)) {
          return false
        }
        if (rawTags.length > 0) {
          const cardTagsLower = card.tags.map((t) => t.toLowerCase())
          const hasOverlap = rawTags.some((t) => cardTagsLower.includes(t))
          if (!hasOverlap) return false
        }
        if (queryLower) {
          const titleMatch = card.title.toLowerCase().includes(queryLower)
          const summaryMatch = card.summary.toLowerCase().includes(queryLower)
          const claimsMatch = card.coreClaims.some((c) => c.toLowerCase().includes(queryLower))
          const tagsMatch = card.tags.some((t) => t.toLowerCase().includes(queryLower))
          const authorMatch = card.source.author.toLowerCase().includes(queryLower)
          if (!titleMatch && !summaryMatch && !claimsMatch && !tagsMatch && !authorMatch) {
            return false
          }
        }
        return true
      })

      // 相关度排序：标签命中（受控主题词）权重最高，其次标题、核心论点、摘要/作者；
      // 同分或无 query 时按 updatedAt 倒序。
      const scored = matched.map((card) => {
        let score = 0
        if (queryLower) {
          if (card.tags.some((t) => t.toLowerCase().includes(queryLower))) score += 4
          if (card.title.toLowerCase().includes(queryLower)) score += 3
          if (card.coreClaims.some((c) => c.toLowerCase().includes(queryLower))) score += 2
          if (card.summary.toLowerCase().includes(queryLower)) score += 1
          if (card.source.author.toLowerCase().includes(queryLower)) score += 1
        }
        return { card, score }
      })
      scored.sort((a, b) =>
        b.score - a.score
        || new Date(b.card.updatedAt).getTime() - new Date(a.card.updatedAt).getTime(),
      )
      const results = scored.slice(0, effectiveLimit).map((s) => s.card)

      const lines: string[] = [
        `[knowledge_search] 匹配到 ${matched.length} 张卡片 (展示前 ${results.length} 项${detail === 'full' ? ', detail=full' : ''}):`,
      ]

      for (const card of results) {
        lines.push(`- [${card.id}] "${card.title}" (${card.source.type} @ ${card.source.author}, 可信度: ${card.credibility})`)
        // 时效证据是判断「过时降权」的依据：更新时间与素材发布日期对所有 detail 档都明示，缺失写「未知」。
        lines.push(`  时间: 更新 ${shownTimestamp(card.updatedAt)} | 发布 ${shownTimestamp(card.source.publishedAt)}`)
        lines.push(`  摘要: ${card.summary}`)
        lines.push(`  标签: ${card.tags.join(', ')} | 链接: ${card.source.url}`)
        if (detail === 'full') {
          lines.push(...renderCardFullLines(card))
        }
      }

      if (results.length === 0) {
        lines.push('（未搜索到符合条件的知识卡片）')
      }

      return lines.join('\n')
    },
  })
}

export function createKnowledgeGetTool(store: KnowledgeCardStore) {
  return defineTool({
    name: 'knowledge_get',
    description:
      'Read one knowledge card in full by id: core claims, the three fact-check buckets, reusable lessons and applicability boundaries. '
      + 'Ids come from knowledge_search results or citation markers in earlier analyses.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Knowledge card id (kc_...).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) return '[knowledge_get] 参数 id 为必填字符串'

      const card = await store.get(id)
      if (!card) return `[knowledge_get] 未找到卡片 [${id}]`

      const lines: string[] = [
        `[knowledge_get] [${card.id}] "${card.title}"`,
        `  摘要: ${card.summary}`,
        `  来源: ${card.source.type} @ ${card.source.author}${card.source.publishedAt ? ` (${card.source.publishedAt})` : ''} | 可信度: ${card.credibility} | 更新: ${card.updatedAt}`,
        `  标签: ${card.tags.join(', ')} | 链接: ${card.source.url}`,
        ...renderCardFullLines(card),
      ]
      if (card.related && card.related.length > 0) lines.push(`  显式关联: ${card.related.join(', ')}`)
      return lines.join('\n')
    },
  })
}

export interface KnowledgeDeleteToolOptions {
  /** 可选：删除成功后的回调（与 ingest 一致，emit('knowledge') 通知 UI 刷新）。 */
  onWritten?: () => void
}

export function createKnowledgeDeleteTool(store: KnowledgeCardStore, options: KnowledgeDeleteToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'knowledge_delete',
    description:
      'Delete (retire) one knowledge card from the local library, for a claim disproved by evidence, a retracted source or a duplicate '
      + 'card. Other cards\' related references to it are cleaned up automatically, and the deleted title and core claims are echoed as a '
      + 'trail. Record the disproof itself separately in the trading journal or the conversation.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Knowledge card id to delete (kc_...). Confirm the id with knowledge_search first; never delete from vague memory.',
      },
      reason: {
        type: 'string',
        description: 'Deletion reason, echoed in the result as a trail.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (!id) return '[knowledge_delete] 参数 id 为必填字符串'

      const target = await store.get(id)
      if (!target) return `[knowledge_delete] 未找到卡片 [${id}]，请先用 knowledge_search 确认卡片 id`

      // 先清理引用方（防 related 悬空），引用变化视为一次修改并刷新 updatedAt。
      // 用 saveMany（存在时）一次落盘：文件版 store 每张 save 都是一次整表事务
      // （锁 + 读盘 + 序列化 + 原子写），引用方多时逐张写会把一次删除放大成 F+1 次。
      const referencing: string[] = []
      const cleaned: KnowledgeCard[] = []
      for (const card of await store.list()) {
        if (card.related && card.related.includes(id)) {
          const remaining = card.related.filter((r) => r !== id)
          referencing.push(card.id)
          cleaned.push({
            ...card,
            related: remaining.length > 0 ? remaining : undefined,
            updatedAt: new Date().toISOString(),
          })
        }
      }
      if (cleaned.length > 0) {
        if (typeof store.saveMany === 'function') await store.saveMany(cleaned)
        else for (const card of cleaned) await store.save(card)
      }

      const removed = await store.delete(id)
      if (!removed) return `[knowledge_delete] 删除失败：卡片 [${id}] 在删除时已不存在`
      onWritten?.()

      const lines: string[] = [
        `[knowledge_delete] 已删除卡片 [${target.id}] "${target.title}"`,
        `  核心论点（留痕回显）: ${target.coreClaims.join('；')}`,
      ]
      if (reason) lines.push(`  删除原因: ${reason}`)
      lines.push(
        referencing.length > 0
          ? `  已清理 ${referencing.length} 张卡片的 related 引用: ${referencing.join(', ')}`
          : '  无其他卡片引用本卡片',
      )
      return lines.join('\n')
    },
  })
}

/** bundle 文件名里的时间戳（本地时区）：用户在导出目录里按时间对号，UTC 会错位。 */
function compactTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 导出/导入共用的路径解析：`~` 前缀展开 + 相对路径按 process.cwd() 解析（与 node 工具惯例一致）。 */
function resolveUserPath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return path.resolve(os.homedir(), trimmed.slice(2))
  return path.resolve(process.cwd(), trimmed)
}

export function createKnowledgeExportTool(store: KnowledgeCardStore) {
  return defineTool({
    name: 'knowledge_export',
    description:
      'Export knowledge cards into one JSON bundle file (meta + cards) for backup or transfer to another library. '
      + 'Filters follow knowledge_search semantics exactly: tags (comma separated, matches any one), sourceType, credibility, '
      + 'and cluster (the card first tag). Without filters the whole library is exported. Import it back with knowledge_import.',
    parameters: {
      path: {
        type: 'string',
        description: 'Target file path (absolute, or relative to the current working directory). Omit it to write $DSH_HOME/knowledge/exports/knowledge-<yyyyMMdd-HHmmss>.json.',
      },
      tags: {
        type: 'string',
        description: 'Comma-separated tag filter, e.g. "宏观,高股息"; matches any one of them.',
      },
      sourceType: {
        type: 'string',
        description: 'Source kind filter: "bilibili" | "wechat" | "manual".',
      },
      credibility: {
        type: 'string',
        description: 'Credibility filter: "high" | "medium" | "low".',
      },
      cluster: {
        type: 'string',
        description: 'Exact subject filter (subject = the card first tag), same as knowledge_search cluster.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
      const rawTags = typeof args.tags === 'string' ? args.tags.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean) : []
      const targetSourceType = typeof args.sourceType === 'string' ? args.sourceType.trim() : ''
      const targetCredibility = typeof args.credibility === 'string' ? args.credibility.trim() : ''
      const targetCluster = typeof args.cluster === 'string' ? args.cluster.trim().toLowerCase() : ''

      // 过滤口径与 knowledge_search 逐条一致：同一组参数在两个工具里选出同一批卡片。
      const selected = (await store.list()).filter((card) => {
        if (targetSourceType && card.source.type !== targetSourceType) return false
        if (targetCredibility && card.credibility !== targetCredibility) return false
        if (targetCluster && (card.tags[0] ?? '').trim().toLowerCase() !== targetCluster) return false
        if (rawTags.length > 0) {
          const cardTags = card.tags.map((tag) => tag.toLowerCase())
          if (!rawTags.some((tag) => cardTags.includes(tag))) return false
        }
        return true
      })

      const filePath = requestedPath.length > 0
        ? resolveUserPath(requestedPath)
        : path.join(dshHomeDir(), 'knowledge', 'exports', `knowledge-${compactTimestamp(new Date())}.json`)
      try {
        await mkdir(path.dirname(filePath), { recursive: true })
        await writeFile(filePath, serializeKnowledgeBundle(createKnowledgeBundle(selected)), 'utf8')
      } catch (error) {
        // 写盘失败按可读文本回报：工具面不抛异常，调用方（agent）才能转述给用户。
        return `[knowledge_export] 导出失败: ${error instanceof Error ? error.message : String(error)}`
      }

      const filterParts: string[] = []
      if (rawTags.length > 0) filterParts.push(`标签命中任一: ${rawTags.join(' / ')}`)
      if (targetSourceType) filterParts.push(`来源类型: ${targetSourceType}`)
      if (targetCredibility) filterParts.push(`可信度: ${targetCredibility}`)
      if (targetCluster) filterParts.push(`主体(聚类): ${targetCluster}`)
      return [
        `[knowledge_export] 已导出 ${selected.length} 张卡片（筛选: ${filterParts.length > 0 ? filterParts.join(' | ') : '全库'}）`,
        `  文件: ${filePath}`,
      ].join('\n')
    },
  })
}

export interface KnowledgeImportToolOptions {
  /** 可选：成功写库后的回调（与 ingest/delete 一致，emit('knowledge') 通知 UI 刷新）。 */
  onWritten?: () => void
}

export function createKnowledgeImportTool(store: KnowledgeCardStore, options: KnowledgeImportToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'knowledge_import',
    description:
      'Import knowledge cards from a JSON bundle file produced by knowledge_export. The dedup key is source.url: mode="skip" '
      + '(default) keeps existing cards and reports them as skipped, mode="overwrite" refreshes their content while keeping the '
      + 'local id and createdAt. The plan is computed first (dryRun=true only previews it, nothing is written), then written with a '
      + 'freshly computed plan. Related ids are remapped inside the bundle; references to cards outside it are dropped and reported.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Bundle JSON file path (absolute, "~/" prefixed, or relative to the current working directory).',
      },
      mode: {
        type: 'string',
        description: 'Duplicate source.url handling: "skip" (default, keep the local card) | "overwrite" (refresh content, keep local id/createdAt).',
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview the plan without writing anything (default false).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
      if (requestedPath.length === 0) return '[knowledge_import] 参数 path 为必填字符串（bundle JSON 文件路径）'

      const rawMode = typeof args.mode === 'string' ? args.mode.trim() : ''
      if (rawMode !== '' && rawMode !== 'skip' && rawMode !== 'overwrite') {
        return `[knowledge_import] 参数 mode 非法: ${rawMode}（允许值: skip, overwrite；省略即 skip）`
      }
      const mode: KnowledgeImportMode = rawMode === 'overwrite' ? 'overwrite' : 'skip'
      // 只有显式 true 才预览：字符串 "false" 或省略都当真写，避免「以为在预览」。
      const dryRun = args.dryRun === true
      const filePath = resolveUserPath(requestedPath)

      let text: string
      try {
        text = await readFile(filePath, 'utf8')
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (code === 'ENOENT') return `[knowledge_import] 文件不存在: ${filePath}`
        return `[knowledge_import] 读取失败: ${error instanceof Error ? error.message : String(error)}（${filePath}）`
      }

      const parsed = parseKnowledgeBundle(text)
      if (!parsed.ok) return `[knowledge_import] ${parsed.error}`

      const local = await store.list()
      const plan = planKnowledgeImport(local, parsed.bundle.cards, mode)
      const toWrite = [...plan.create, ...plan.update]
      let written = 0
      if (!dryRun && toWrite.length > 0) {
        try {
          // 能力存在时一次事务落盘（文件版 store 每张 save 都是一次整表事务）。
          if (typeof store.saveMany === 'function') await store.saveMany(toWrite)
          else for (const card of toWrite) await store.save(card)
        } catch (error) {
          return `[knowledge_import] 写入失败: ${error instanceof Error ? error.message : String(error)}（计划写入 ${toWrite.length} 张）`
        }
        written = toWrite.length
        onWritten?.()
      }

      const lines: string[] = [
        `[knowledge_import] ${dryRun ? 'dryRun 预览（未写库）' : `已写入 ${written} 张`}, mode=${mode}`,
        `  新增 ${plan.create.length} / 更新 ${plan.update.length} / 跳过 ${plan.skipped.length} / 丢弃关联 ${plan.droppedRelated.length} / 非法 ${plan.invalid.length}`,
      ]
      for (const entry of plan.skipped) lines.push(`  跳过: [${entry.id}] "${entry.title}"（${entry.reason}）`)
      for (const entry of plan.droppedRelated) lines.push(`  丢弃关联: [${entry.id}] 缺失 ${entry.missing.join(', ')}`)
      for (const entry of plan.invalid) {
        const title = entry.title === undefined ? '' : ` "${entry.title}"`
        lines.push(`  非法: 第 ${entry.index + 1} 张卡（下标 ${entry.index}）${title}: ${entry.error}`)
      }
      for (const entry of plan.remappedIds) lines.push(`  id 重映射: ${entry.from} → ${entry.to}`)
      if (toWrite.length === 0) lines.push('  （没有需要写入的卡片）')
      return lines.join('\n')
    },
  })
}

