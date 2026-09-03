/**
 * A 股工具箱插件（dsh-trading cn 切片）。
 *
 * 包含：
 *   1. skill provider：cn-risk-checklist、indicator-authoring、trading-strategy-paradigms、knowledge-curation 与 trading-notes-setup 随包分发；
 *   2. cn_get_news 与 cn_get_fundamentals 工具；
 *   3. indicator_author 创作工具（Issue #19）；
 *   4. knowledge_ingest 与 knowledge_search 知识库工具（Issue #24）。
 *
 * @module @dsh-trading/kit-cn
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createGetIndicatorsTool } from '@dsh-trading/indicators/tool'
import type { MarketDataService } from '@dsh-trading/api'
import { aggregateNews, type AggregateNewsOptions } from './news.js'
import { fetchCnFundamentals, renderCnFundamentals } from './fundamentals.js'
import {
  fetchCnAuctionStrength,
  fetchCnLimitUpLadder,
  fetchCnLimitUpPool,
} from './sentiment.js'

export * from './fundamentals.js'
export * from './news.js'
export * from './sentiment.js'

// ── skill provider（host 面 skill 全局可见即可，本切片不改 skill 作用域） ─────────

const PROVIDER_NAME = 'dsh-trading-cn'

const SKILL_BODY_URL = new URL('../assets/skills/cn-risk-checklist.md', import.meta.url)
const AUTHORING_BODY_URL = new URL('../assets/skills/indicator-authoring.md', import.meta.url)
const STRATEGY_BODY_URL = new URL('../assets/skills/trading-strategy-paradigms.md', import.meta.url)
const KNOWLEDGE_CURATION_BODY_URL = new URL('../assets/skills/knowledge-curation.md', import.meta.url)
const JOURNAL_BODY_URL = new URL('../assets/skills/trading-notes-setup.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/skills/', import.meta.url)),
} as const

const CANDIDATE: SkillCandidate = {
  name: 'cn-risk-checklist',
  description: 'A 股交易风控检查清单：开仓前逐项核对 T+1 交收、涨跌停板与一字板流动性、ST/*ST 退市风险、融资融券门槛、限售与大宗折价。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const AUTHORING_CANDIDATE: SkillCandidate = {
  name: 'indicator-authoring',
  description: '自定义技术指标创作指南：根据用户自然语言需求生成符合契约的指标代码（TD9/SuperTrend/OBV+MA等），并通过 indicator_author 工具验证与落库。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: AUTHORING_BODY_URL,
}

const STRATEGY_CANDIDATE: SkillCandidate = {
  name: 'trading-strategy-paradigms',
  description: '经典交易策略参考范式指南：提供短线（唐奇安突破/RSI极值回归）、波段（EMA双均线/布林带下轨回归）、长线（200日均线基线/12月动量）6大策略原理、参数调优、8项回测指标研读与风险防范 SOP。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: STRATEGY_BODY_URL,
}

const KNOWLEDGE_CURATION_CANDIDATE: SkillCandidate = {
  name: 'knowledge-curation',
  description: '财经观点沉淀与知识库策展指南：基于 Content Insight 事实核查产物，规范化提取知识卡片字段、受控词表对齐、查重与关联建立，通过 knowledge_ingest 工具入库。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: KNOWLEDGE_CURATION_BODY_URL,
}

const JOURNAL_CANDIDATE: SkillCandidate = {
  name: 'trading-notes-setup',
  description:
    '交易日志建立与记录规范：检查/创建工作区 .trading-journal/ 双轨目录（agent 轨 + human 轨），分别记录 agent 与人类各自的操作。会话启动检查发现工作区没有交易日志目录时调用本技能建立骨架；记录条目格式以本技能为权威。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: JOURNAL_BODY_URL,
}

const SKILL_CANDIDATES = [CANDIDATE, AUTHORING_CANDIDATE, STRATEGY_CANDIDATE, KNOWLEDGE_CURATION_CANDIDATE, JOURNAL_CANDIDATE]

export const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(SKILL_CANDIDATES),
  async get(candidate): Promise<SkillDefinition> {
    const target = SKILL_CANDIDATES.find((c) => c.name === candidate.name) ?? CANDIDATE
    return {
      name: target.name,
      description: target.description,
      invocation: target.invocation,
      provider: target.provider,
      source: target.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(target.locator, 'utf8'),
    }
  },
}

// ── 插件配置 ──────────────────────────────────────────────────────────────────

export interface Config {
  dryRun: boolean
  liveTrading: boolean
}

export const Config: Schema<Config> = Schema.object({
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
})

export const inject = ['skills', 'tools']

export const name = 'dsh-trading-cn-kit'

// ── 插件入口 ──────────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Config): void {
  ctx.skills.registerProvider(() => provider)

  const newsTool = createGetNewsTool()
  const fundamentalsTool = createGetFundamentalsTool()
  const limitUpTool = createGetLimitUpPoolTool()
  const auctionTool = createGetAuctionStrengthTool()

  const tools = ctx.tools as unknown as {
    register(definition: { name: string }): unknown
    get(name: string): { name: string } | undefined
  }

  const registerOnce = (tool: ReturnType<typeof defineTool>): void => {
    if (tools.get(tool.name) !== undefined) {
      ctx.logger('dsh-trading-cn-kit').info(
        '[dsh-trading-cn-kit] tool %s already registered by another provider — skipped (mutual exclusion)',
        tool.name,
      )
      return
    }
    tools.register(tool)
  }

  registerOnce(newsTool)
  registerOnce(fundamentalsTool)
  registerOnce(limitUpTool)
  registerOnce(auctionTool)

  // issue #33 收口：indicator_author / knowledge_ingest / knowledge_search 已迁移至
  // @dsh-trading/indicators/plugin 与 @dsh-trading/knowledge/plugin（base patch 行，
  // host 平面单点注册）；kit 保留市场专属工具与 skill provider，不再重复注册。

  // issue #33：cn_get_indicators 接入（计算库市场无关；行情 registry-first，老部署回退市场键）。
  const serviceGetter = ctx as unknown as { get?: (key: string) => unknown }
  const registry = serviceGetter.get?.('tradingMarketDataRegistry', false) as
    | { active(m: string): { service: MarketDataService } | undefined }
    | undefined
  const marketData = registry?.active('cn')?.service
    ?? serviceGetter.get?.('tradingCnMarketData', false) as MarketDataService | undefined
  if (marketData !== undefined) {
    registerOnce(createGetIndicatorsTool({ marketData, market: 'cn' }))
  }

  // 新闻聚合器注册到 host 面注册表（Issue #37）。
  // 新闻聚合器注册到 host 面注册表（Issue #37）：注册表服务就绪时机不定，经
  // cordis inject 等待就绪后注册。kit 编译程序下 cordis Context 类型增强不完整
  // （Context['inject'] 探针报缺），与上方 serviceGetter 同款 duck-type 处理。
  const lifecycle = ctx as unknown as {
    inject?: (deps: string[], callback: (scope: unknown) => void) => void
    effect?: (fn: () => void, name?: string) => void
  }
  lifecycle.inject?.(['tradingNewsRegistry'], (scope) => {
    const registry = (scope as { tradingNewsRegistry?: { register(market: string, aggregator: unknown): () => void } }).tradingNewsRegistry
    if (registry && typeof registry.register === 'function') {
      lifecycle.effect?.(() => registry.register('cn', aggregateNews), 'kit-cn news registration')
    }
  })
}

/* ── cn_get_news：A 股新闻工具（WS3） ────────────────────────────────────────── */

const DEFAULT_NEWS_WINDOW_HOURS = 24
const DEFAULT_NEWS_LIMIT = 20

function renderNewsItem(item: { source: string; title: string; url: string; publishedAt: string }): string {
  return `[${item.source}] ${item.publishedAt}  ${item.title}\n  ${item.url}`
}

export function createGetNewsTool() {
  const description =
    'Get recent China A-share market news, announcements, and macro financial updates from Eastmoney financial fast-news feed. '
    + 'Aggregates and sorts newest-first; each item carries source name (东方财富), publish time and a link for traceability. '
    + 'Optionally filter by symbol (A-share code, e.g. 600519 / 000001) and by a time window. '
    + 'Fetches metadata only, never redistributes article bodies. No credentials required.'
  return defineTool({
    name: 'cn_get_news',
    description,
    parameters: {
      symbol: {
        type: 'string',
        description: 'Optional symbol to filter by, market-canonical vocabulary, e.g. 600519 or 000001 (A-share code). Best-effort matched against Eastmoney stock tags.',
      },
      windowHours: {
        type: 'number',
        description: `Only keep items published within the last N hours (1-168, default ${DEFAULT_NEWS_WINDOW_HOURS}).`,
        default: DEFAULT_NEWS_WINDOW_HOURS,
      },
      limit: {
        type: 'number',
        description: `Max items to return (1-50, default ${DEFAULT_NEWS_LIMIT}).`,
        default: DEFAULT_NEWS_LIMIT,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { symbol?: unknown; windowHours?: unknown; limit?: unknown }
      const options: AggregateNewsOptions = {
        symbol: typeof args.symbol === 'string' ? args.symbol : undefined,
        windowHours: typeof args.windowHours === 'number' ? args.windowHours : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      }
      const { items, unavailable } = await aggregateNews(options)
      if (items.length === 0 && unavailable.length === 0) {
        return 'cn_get_news: no news items found within the requested window.'
      }
      const symbolNote = options.symbol ? ` symbol=${options.symbol.trim()}` : ''
      const lines = [
        `cn_get_news — ${items.length} item(s)${symbolNote}, window=${options.windowHours ?? DEFAULT_NEWS_WINDOW_HOURS}h (newest-first):`,
        ...items.map(renderNewsItem),
      ]
      if (unavailable.length > 0) {
        lines.push('  (source(s) unavailable this call: ' + unavailable.join('; ') + ')')
      }
      return lines.join('\n')
    },
  })
}

/* ── cn_get_fundamentals：A 股基本面工具（WS3） ───────────────────────────────── */

export function createGetFundamentalsTool(options: { fetch?: typeof globalThis.fetch; skipCache?: boolean } = {}) {
  return defineTool({
    name: 'cn_get_fundamentals',
    description:
      'Get fundamental valuation and financial indicators for China A-share stocks (Total Market Cap, Float Market Cap, Dynamic P/E, Trailing P/E, P/B, Dividend Yield, Turnover Rate, Amplitude, 52-Week Range, Industry/Sector) via Tencent public market quote API. Accepts market-canonical code (e.g. 600519.SS, 000001.SZ) or 6-digit code (600519). No credentials required.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'A-share stock symbol or code, market-canonical vocabulary, e.g. 600519.SS, 000001.SZ, 600519, 000001',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { symbol?: unknown }
      const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : ''
      if (!symbol) {
        throw new Error('cn_get_fundamentals: symbol parameter is required (e.g. 600519.SS or 600519)')
      }
      const result = await fetchCnFundamentals({
        symbol,
        fetch: options.fetch,
        skipCache: options.skipCache ?? (options.fetch !== undefined),
      })
      return renderCnFundamentals(result, symbol)
    },
  })
}

/* ── cn_get_limit_up_pool：A 股涨跌停池工具（同花顺数据源） ─────────────────── */

export function createGetLimitUpPoolTool(options: { fetch?: typeof globalThis.fetch } = {}) {
  return defineTool({
    name: 'cn_get_limit_up_pool',
    description:
      '获取 A 股当日涨停股票池、连板天梯、封单金额与题材涨停原因（同花顺数据源，需配置 HITHINK_FINANCE_API_KEY）。',
    parameters: {
      page: { type: 'number', description: '页码，默认 1' },
      size: { type: 'number', description: '每页条数，默认 50' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { page?: number; size?: number }
      try {
        const pool = await fetchCnLimitUpPool({ page: args.page, size: args.size }, { fetchImpl: options.fetch })
        if (pool.length === 0) return 'cn_get_limit_up_pool: 当前无涨停条目或非交易时间。'
        const lines = [
          `A 股涨停池共 ${pool.length} 只股票（按涨停时间排序）：`,
          ...pool.map(p => `- ${p.name} (${p.symbol}): 现价 ￥${p.price} (+${p.changePercent}%), ${p.consecutiveBoards ?? 1} 连板, 封单 ￥${((p.limitOrderAmount ?? 0) / 100000000).toFixed(2)} 亿, 原因: ${p.sectorConcept ?? '无'}`),
        ]
        return lines.join('\n')
      } catch (err) {
        return `cn_get_limit_up_pool 获取失败: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
}

/* ── cn_get_auction_strength：A 股集合竞价快照工具（同花顺数据源） ─────────── */

export function createGetAuctionStrengthTool(options: { fetch?: typeof globalThis.fetch } = {}) {
  return defineTool({
    name: 'cn_get_auction_strength',
    description:
      '获取 A 股标的早盘集合竞价匹配量、未匹配金额与强弱基准（同花顺数据源，需配置 HITHINK_FINANCE_API_KEY）。',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'A 股股票代码，如 600519.SH 或 600519',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { symbol?: unknown }
      const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : ''
      if (!symbol) throw new Error('cn_get_auction_strength: symbol parameter is required')
      try {
        const auction = await fetchCnAuctionStrength(symbol, { fetchImpl: options.fetch })
        if (!auction) return `cn_get_auction_strength: 暂无 ${symbol} 集合竞价快照数据（非竞价时间或未配置 HITHINK_FINANCE_API_KEY）。`
        return [
          `标的 ${auction.symbol} 集合竞价快照：`,
          `- 匹配价格: ￥${auction.matchPrice ?? 'N/A'}`,
          `- 匹配数量: ${auction.matchVolume ?? 'N/A'} 股`,
          `- 未匹配数量: ${auction.unmatchedVolume ?? 'N/A'} 股 (${auction.unmatchedSide === 'buy' ? '买单多' : '卖单多'})`,
          `- 竞价强弱指数: ${auction.strengthIndex ?? 'N/A'}`,
          `- 竞价阶段: ${auction.stage ?? 'N/A'}`,
        ].join('\n')
      } catch (err) {
        return `cn_get_auction_strength 获取失败: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
}
