/**
 * US 工具箱插件（dsh-trading us 切片）。
 *
 * 包含：
 *   1. skill provider：us-risk-checklist、indicator-authoring、trading-strategy-paradigms、knowledge-curation 与 trading-notes-setup 随包分发；
 *   2. us_get_news 与 us_get_fundamentals 工具；
 *   3. indicator_author 创作工具（Issue #19）；
 *   4. knowledge_ingest 与 knowledge_search 知识库工具（Issue #24）。
 *
 * @module @dsh-trading/kit-us
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
import { fetchUsFundamentals, renderUsFundamentals } from './fundamentals.js'

export * from './fundamentals.js'
export * from './news.js'

// ── skill provider（host 面 skill 全局可见即可，本切片不改 skill 作用域） ─────────

const PROVIDER_NAME = 'dsh-trading-us'

const SKILL_BODY_URL = new URL('../assets/skills/us-risk-checklist.md', import.meta.url)
const AUTHORING_BODY_URL = new URL('../assets/skills/indicator-authoring.md', import.meta.url)
const STRATEGY_BODY_URL = new URL('../assets/skills/trading-strategy-paradigms.md', import.meta.url)
const KNOWLEDGE_CURATION_BODY_URL = new URL('../assets/skills/knowledge-curation.md', import.meta.url)
const JOURNAL_BODY_URL = new URL('../assets/skills/trading-notes-setup.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/skills/', import.meta.url)),
} as const

const CANDIDATE: SkillCandidate = {
  name: 'us-risk-checklist',
  description: '美股交易风控检查清单：开仓前逐项核对盘前盘后流动性、熔断与停牌、做空规则、T+1 与 PDT 日内限制、财报跳空风险。',
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

export const name = 'dsh-trading-us-kit'

// ── 插件入口 ──────────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Config): void {
  ctx.skills.registerProvider(() => provider)

  const newsTool = createGetNewsTool()
  const fundamentalsTool = createGetFundamentalsTool()

  const tools = ctx.tools as unknown as {
    register(definition: { name: string }): unknown
    get(name: string): { name: string } | undefined
  }

  const registerOnce = (tool: ReturnType<typeof defineTool>): void => {
    if (tools.get(tool.name) !== undefined) {
      ctx.logger('dsh-trading-us-kit').info(
        '[dsh-trading-us-kit] tool %s already registered by another provider — skipped (mutual exclusion)',
        tool.name,
      )
      return
    }
    tools.register(tool)
  }

  registerOnce(newsTool)
  registerOnce(fundamentalsTool)

  // issue #33 收口：indicator_author / knowledge_ingest / knowledge_search 已迁移至
  // @dsh-trading/indicators/plugin 与 @dsh-trading/knowledge/plugin（base patch 行，
  // host 平面单点注册）；kit 保留市场专属工具与 skill provider，不再重复注册。

  // issue #33：us_get_indicators 接入（计算库市场无关；行情 registry-first，老部署回退市场键）。
  const serviceGetter = ctx as unknown as { get?: (key: string) => unknown }
  const registry = serviceGetter.get?.('tradingMarketDataRegistry', false) as
    | { active(m: string): { service: MarketDataService } | undefined }
    | undefined
  const marketData = registry?.active('us')?.service
    ?? serviceGetter.get?.('tradingUsMarketData', false) as MarketDataService | undefined
  if (marketData !== undefined) {
    registerOnce(createGetIndicatorsTool({ marketData, market: 'us' }))
  }

  // 新闻聚合器注册到 host 面注册表（Issue #37）。
  ctx.inject(['tradingNewsRegistry'] as never, (newsCtx: any) => {
    const registry = (newsCtx as any).tradingNewsRegistry
    if (registry && typeof registry.register === 'function') {
      ctx.effect(() => registry.register('us', aggregateNews), 'kit-us news registration')
    }
  })
}

/* ── us_get_news：美股新闻工具（WS2 #1） ────────────────────────────────────────── */

const DEFAULT_NEWS_WINDOW_HOURS = 24
const DEFAULT_NEWS_LIMIT = 20

function renderNewsItem(item: { source: string; title: string; url: string; publishedAt: string }): string {
  return `[${item.source}] ${item.publishedAt}  ${item.title}\n  ${item.url}`
}

export function createGetNewsTool() {
  const description =
    'Get recent US stock market news from Yahoo Finance RSS and CNBC RSS feeds. '
    + 'Aggregates and sorts newest-first; each item carries source name, publish time and a link for traceability. '
    + 'Optionally filter by symbol (e.g. AAPL, TSLA, NVDA) and by a time window. '
    + 'Source failures are tolerated and reported instead of failing the whole call. No credentials required.'
  return defineTool({
    name: 'us_get_news',
    description,
    parameters: {
      symbol: {
        type: 'string',
        description: 'Optional US stock symbol to filter by (e.g. AAPL, TSLA, NVDA). Matched against item titles.',
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
        return 'us_get_news: no news items found within the requested window.'
      }
      const symbolNote = options.symbol ? ` symbol=${options.symbol.trim().toUpperCase()}` : ''
      const lines = [
        `us_get_news — ${items.length} item(s)${symbolNote}, window=${options.windowHours ?? DEFAULT_NEWS_WINDOW_HOURS}h (newest-first):`,
        ...items.map(renderNewsItem),
      ]
      if (unavailable.length > 0) {
        lines.push('  (source(s) unavailable this call: ' + unavailable.join('; ') + ')')
      }
      return lines.join('\n')
    },
  })
}

/* ── us_get_fundamentals：美股基本面工具（WS2） ───────────────────────────────── */

export function createGetFundamentalsTool(options: { fetch?: typeof globalThis.fetch } = {}) {
  return defineTool({
    name: 'us_get_fundamentals',
    description:
      'Get fundamental valuation and financial indicators for US stocks (Market Cap, Trailing P/E, Forward P/E, P/B, Dividend Yield, Beta, 52-Week High/Low, EPS, 50-Day & 200-Day Moving Averages) via Stooq public equity data. Accepts market-canonical symbol (e.g. AAPL.US, TSLA.US) or pure ticker (AAPL, TSLA). No credentials required.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'US stock symbol or ticker, market-canonical vocabulary, e.g. AAPL.US, TSLA.US, AAPL, TSLA',
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
        throw new Error('us_get_fundamentals: symbol parameter is required (e.g. AAPL.US or AAPL)')
      }
      const result = await fetchUsFundamentals({ symbol, fetch: options.fetch })
      return renderUsFundamentals(result, symbol)
    },
  })
}
