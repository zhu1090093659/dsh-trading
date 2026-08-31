/**
 * 知识库 Agent 工具（对齐 docs/design/knowledge-graph.md §4 与 dsh-tools 规范）。
 *
 * 包含：
 *   - knowledge_ingest: 结构校验 + URL 查重 Update / Create
 *   - knowledge_search: 跨字段大小写不敏感检索与多维过滤
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

export function createKnowledgeIngestTool(store: KnowledgeCardStore) {
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
      + '支持跨标题、概述、核心论点、标签的不区分大小写子串搜索，以及按作者、来源类型、可信度多维过滤。',
    parameters: {
      query: {
        type: 'string',
        description: '搜索关键词（在标题、摘要、核心论点、标签中模糊匹配）',
      },
      tags: {
        type: 'string',
        description: '逗号分隔的标签过滤（例如 "宏观,高股息"，匹配其中任意一个）',
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
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const params = (raw ?? {}) as {
        query?: unknown
        tags?: unknown
        author?: unknown
        sourceType?: unknown
        credibility?: unknown
        limit?: unknown
      }

      const allCards = await store.list()
      const queryLower = typeof params.query === 'string' ? params.query.trim().toLowerCase() : ''
      const authorLower = typeof params.author === 'string' ? params.author.trim().toLowerCase() : ''
      const rawTags = typeof params.tags === 'string' ? params.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : []
      const targetSourceType = typeof params.sourceType === 'string' ? params.sourceType.trim() : undefined
      const targetCredibility = typeof params.credibility === 'string' ? params.credibility.trim() : undefined
      const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(params.limit, 100)) : 20

      const matched = allCards.filter((card) => {
        if (targetSourceType && card.source.type !== targetSourceType) {
          return false
        }
        if (targetCredibility && card.credibility !== targetCredibility) {
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

      matched.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      const results = matched.slice(0, limit)

      const lines: string[] = [
        `[knowledge_search] 匹配到 ${matched.length} 张卡片 (展示前 ${results.length} 项):`,
      ]

      for (const card of results) {
        lines.push(`- [${card.id}] "${card.title}" (${card.source.type} @ ${card.source.author}, 可信度: ${card.credibility})`)
        lines.push(`  摘要: ${card.summary}`)
        lines.push(`  标签: ${card.tags.join(', ')} | 链接: ${card.source.url}`)
      }

      if (results.length === 0) {
        lines.push('（未搜索到符合条件的知识卡片）')
      }

      return lines.join('\n')
    },
  })
}
