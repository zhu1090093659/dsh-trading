/**
 * US 工具箱插件（dsh-trading us 切片）。
 *
 * 包含：
 *   1. skill provider：us-risk-checklist 与 indicator-authoring 随包分发；
 *   2. us_get_news 与 us_get_fundamentals 工具；
 *   3. indicator_author 创作工具（Issue #19）。
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
import { createAuthorIndicatorTool, createFileCustomIndicatorStore } from '@dsh-trading/indicators/tool'
import { aggregateNews, type AggregateNewsOptions } from './news.js'
import { fetchUsFundamentals, renderUsFundamentals } from './fundamentals.js'

// ── skill provider（host 面 skill 全局可见即可，本切片不改 skill 作用域） ─────────

const PROVIDER_NAME = 'dsh-trading-us'

const SKILL_BODY_URL = new URL('../assets/skills/us-risk-checklist.md', import.meta.url)
const AUTHORING_BODY_URL = new URL('../assets/skills/indicator-authoring.md', import.meta.url)
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

const SKILL_CANDIDATES = [CANDIDATE, AUTHORING_CANDIDATE]

const provider: SkillProvider = {
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

  // Issue #19：注册自定义指标创作工具 indicator_author（共享 ~/.dsh/indicators/custom.json）
  const indicatorStorePath = path.join(os.homedir(), '.dsh', 'indicators', 'custom.json')
  const authorStore = createFileCustomIndicatorStore(indicatorStorePath)
  registerOnce(createAuthorIndicatorTool({ store: authorStore }))
}

/* ── us_get_news：美股新闻工具（WS4 #1，#6） ─────────────────────────────────── */

const DEFAULT_NEWS_WINDOW_HOURS = 24
const DEFAULT_NEWS_LIMIT = 20

function renderNewsItem(item: { source: string; title: string; url: string; publishedAt: string }): string {
  return `[${item.source}] ${item.publishedAt}  ${item.title}\n  ${item.url}`
}

export function createGetNewsTool() {
  const description =
    'Get recent US stock market news from public no-key sources (Yahoo Finance news + Google News RSS). '
    + 'Aggregates and sorts newest-first; each item carries source name (publisher), publish time and a link for traceability. '
    + 'Optionally filter by symbol (matched against item titles; note media headlines often use company names like "Apple" rather than tickers) and by a time window. '
    + 'Source failures are tolerated and reported instead of failing the whole call. No credentials required. Distinguish announcements/regulatory from opinion (media) when citing.'
  return defineTool({
    name: 'us_get_news',
    description,
    parameters: {
      symbol: {
        type: 'string',
        description: 'Optional symbol to filter by, market-canonical vocabulary, e.g. AAPL or TSLA. Used as the search query and matched against item titles.',
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

/* ── us_get_fundamentals：美股基本面工具（WS4） ───────────────────────────────── */

export function createGetFundamentalsTool(options: { fetch?: typeof globalThis.fetch } = {}) {
  return defineTool({
    name: 'us_get_fundamentals',
    description:
      'Get fundamental valuation and financial metrics for a US stock (Market Cap, Trailing P/E, Forward P/E, P/B, Diluted EPS, Dividend Yield, Beta, 52-Week Range, 3-Month Average Volume) via Yahoo Finance public API. Accepts market-canonical ticker, e.g. AAPL, TSLA, NVDA. No credentials required.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'US stock ticker symbol, market-canonical vocabulary, e.g. AAPL, MSFT, TSLA, NVDA',
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
        throw new Error('us_get_fundamentals: symbol parameter is required (e.g. AAPL or TSLA)')
      }
      const result = await fetchUsFundamentals({ symbol, fetch: options.fetch })
      return renderUsFundamentals(result, symbol)
    },
  })
}
