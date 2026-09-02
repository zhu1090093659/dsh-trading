/**
 * 知识库 Agent 工具（对齐 docs/design/knowledge-graph.md §4 与 dsh-tools 规范）。
 *
 * 包含：
 *   - knowledge_ingest: 结构校验 + URL 查重 Update / Create
 *   - knowledge_search: 跨字段检索（相关度排序）+ 多维过滤 + detail=full 全文返回
 *   - knowledge_get:    按 id 读取单张卡片全文
 *   - knowledge_delete: 证伪下架（删除卡片并清理 related 悬空引用）
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { validateKnowledgeCard } from './validate.ts'
import { createFileKnowledgeCardStore } from './knowledge-fs.ts'
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

export function createKnowledgeIngestTool(store: KnowledgeCardStore, options: KnowledgeIngestToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'knowledge_ingest',
    description:
      '将经事实核查后的结构化知识卡片（Content Insight 产物）入库到本地知识库。'
      + '支持自动 URL 查重（重复 URL 自动走更新且保持 ID 不变）及关联关系验证。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: '知识卡片主题（例如「高股息策略在低利率环境下的防御逻辑」）',
      },
      summary: {
        type: 'string',
        required: true,
        description: '2-4 条核心论点合并的一句话概述（图谱 hover 与快速导读展示）',
      },
      sourceType: {
        type: 'string',
        required: true,
        description: '素材来源类型："bilibili"（B站）、"wechat"（微信公众号）、"manual"（手工录入）',
      },
      sourceUrl: {
        type: 'string',
        required: true,
        description: '素材链接或去重标识（例如 B 站 BV 链接、公众号文章链接）',
      },
      sourceAuthor: {
        type: 'string',
        required: true,
        description: '来源作者/UP主/公众号名称',
      },
      publishedAt: {
        type: 'string',
        description: '素材发布日期（ISO 格式如 2026-08-30，可选）',
      },
      credibility: {
        type: 'string',
        required: true,
        description: '依据事实核查整体定级："high"（事实严密证据充分）、"medium"（观点可取但部分有出入）、"low"（存在重大未核实或明显漏洞）',
      },
      coreClaimsJson: {
        type: 'string',
        required: true,
        description: 'JSON 字符串数组，核心论点列表（保留原作者推理链条），例如 \'["论点1", "论点2"]\'',
      },
      factCheckJson: {
        type: 'string',
        required: true,
        description: 'JSON 对象，事实核查三档分类，例如 \'{"verified":["证实1"],"discrepancies":["出入1"],"unverifiable":[]}\'',
      },
      takeawaysJson: {
        type: 'string',
        description: '可选 JSON 字符串数组，可复用的分析框架与经验总结，例如 \'["经验1"]\'',
      },
      boundariesJson: {
        type: 'string',
        description: '可选 JSON 字符串数组，适用边界、失效情景与避坑指南，例如 \'["边界1"]\'',
      },
      tagsJson: {
        type: 'string',
        required: true,
        description: 'JSON 字符串数组，受控主题标签列表，例如 \'["宏观", "高股息", "红利策略"]\'',
      },
      tickersJson: {
        type: 'string',
        description: '可选 JSON 字符串数组，关联标的代码列表，例如 \'["BTCUSDT", "600519.SH"]\'',
      },
      relatedJson: {
        type: 'string',
        description: '可选 JSON 字符串数组，显式关联的其他已入库卡片 ID 列表，例如 \'["kc_01j...", "kc_01k..."]\'',
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
      return `[knowledge_ingest] ${actionDesc} [${card.id}] "${card.title}" (标签: ${card.tags.join(', ')}${card.related?.length ? `, 关联: ${card.related.join(', ')}` : ''})`
    },
  })
}

export function createKnowledgeSearchTool(store: KnowledgeCardStore) {
  return defineTool({
    name: 'knowledge_search',
    description:
      '检索本地知识库中的知识卡片。'
      + '有关键词时按字段命中相关度排序（标签 > 标题 > 核心论点 > 摘要/作者），无关键词时按更新时间倒序；'
      + '支持按主体（cluster，配合 knowledge_graph 两级检索）、作者、来源类型、可信度多维过滤。'
      + 'detail="full" 时同时返回核心论点、事实核查与可复用经验全文（上限 20 张）。',
    parameters: {
      query: {
        type: 'string',
        description: '搜索关键词（在标题、摘要、核心论点、标签中模糊匹配）',
      },
      tags: {
        type: 'string',
        description: '逗号分隔的标签过滤（例如 "宏观,高股息"，匹配其中任意一个）',
      },
      cluster: {
        type: 'string',
        description: '按主体精确过滤（主体 = 图谱聚类键 = 卡片首个标签）。两级检索第二级：先 knowledge_graph 看主体分布，再用本参数钻取该主体下的卡片',
      },
      author: {
        type: 'string',
        description: '按作者/UP主/公众号过滤（子串匹配）',
      },
      sourceType: {
        type: 'string',
        description: '按来源类型过滤："bilibili" | "wechat" | "manual"',
      },
      credibility: {
        type: 'string',
        description: '按可信度过滤："high" | "medium" | "low"',
      },
      limit: {
        type: 'number',
        description: '最大返回数量（默认 20）',
        default: 20,
      },
      detail: {
        type: 'string',
        description: '返回详略："summary"（默认，摘要级）| "full"（附核心论点/事实核查/经验/边界全文）',
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
      '按 id 读取单张知识卡片的完整内容（核心论点、事实核查三桶、可复用经验、适用边界）。'
      + 'id 可来自 knowledge_search 结果或历史分析中的引用标注。',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: '知识卡片 id（kc_...）',
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
      '从本地知识库删除（下架）指定知识卡片。用于知识点/经验被事实证伪、来源撤稿或卡片重复等场景。'
      + '删除时自动清理其他卡片指向本卡片的 related 引用，并在输出中回显被删卡片的标题与核心论点留痕；'
      + '证伪结论本身应另行记入交易日志或对话沉淀。',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: '要删除的知识卡片 id（kc_...）。不确定 id 时先用 knowledge_search 查询确认，不要凭模糊记忆删除。',
      },
      reason: {
        type: 'string',
        description: '删除原因（如「核心论点被 XX 数据证伪」「来源撤稿」），回显在结果中供留痕',
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
      const referencing: string[] = []
      for (const card of await store.list()) {
        if (card.related && card.related.includes(id)) {
          const remaining = card.related.filter((r) => r !== id)
          referencing.push(card.id)
          await store.save({
            ...card,
            related: remaining.length > 0 ? remaining : undefined,
            updatedAt: new Date().toISOString(),
          })
        }
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
