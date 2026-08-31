/**
 * Crypto 工具箱插件（dsh-trading crypto 切片）。
 *
 * 包含：
 *   1. skill provider：crypto-risk-checklist、crypto-instrument-analysis、indicator-authoring、trading-strategy-paradigms 与 knowledge-curation 随包分发；
 *   2. crypto_get_news、crypto_get_derivatives、crypto_get_fundamentals 工具；
 *   3. indicator_author 创作工具（Issue #19）；
 *   4. knowledge_ingest 与 knowledge_search 知识库工具（Issue #24）。
 *
 * @module @dsh-trading/kit-crypto
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
import { createKnowledgeIngestTool, createKnowledgeSearchTool, createFileKnowledgeCardStore } from '@dsh-trading/knowledge/tool'
import { aggregateNews, type AggregateNewsOptions } from './news.js'
import { fetchCryptoDerivatives, renderDerivativesData } from './derivatives.js'
import { fetchCryptoFundamentals, renderCryptoFundamentals } from './fundamentals.js'

// ── skill provider（host 面 skill 全局可见即可，本切片不改 skill 作用域） ─────────

const PROVIDER_NAME = 'dsh-trading-crypto'

const SKILL_BODY_URL = new URL('../assets/skills/crypto-risk-checklist.md', import.meta.url)
const ANALYSIS_BODY_URL = new URL('../assets/skills/crypto-instrument-analysis.md', import.meta.url)
const AUTHORING_BODY_URL = new URL('../assets/skills/indicator-authoring.md', import.meta.url)
const STRATEGY_BODY_URL = new URL('../assets/skills/trading-strategy-paradigms.md', import.meta.url)
const KNOWLEDGE_CURATION_BODY_URL = new URL('../assets/skills/knowledge-curation.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/skills/', import.meta.url)),
} as const

const CANDIDATE: SkillCandidate = {
  name: 'crypto-risk-checklist',
  description: '加密合约交易风控检查清单：开仓前逐项核对杠杆、仓位、资金费率与强平价。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const ANALYSIS_CANDIDATE: SkillCandidate = {
  name: 'crypto-instrument-analysis',
  description: '加密标的定性分析框架：趋势结构→量价→波动率→资金面→新闻面五步，输出带依据与反方情景的定性结论。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: ANALYSIS_BODY_URL,
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

const SKILL_CANDIDATES = [
  CANDIDATE,
  ANALYSIS_CANDIDATE,
  AUTHORING_CANDIDATE,
  STRATEGY_CANDIDATE,
  KNOWLEDGE_CURATION_CANDIDATE,
]

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

export const name = 'dsh-trading-crypto-kit'

// ── 插件入口 ──────────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Config): void {
  ctx.skills.registerProvider(() => provider)

  const newsTool = createGetNewsTool()
  const derivativesTool = createGetDerivativesTool()
  const fundamentalsTool = createGetFundamentalsTool()

  const tools = ctx.tools as unknown as {
    register(definition: { name: string }): unknown
    get(name: string): { name: string } | undefined
  }

  const registerOnce = (tool: ReturnType<typeof defineTool>): void => {
    if (tools.get(tool.name) !== undefined) {
      ctx.logger('dsh-trading-crypto-kit').info(
        '[dsh-trading-crypto-kit] tool %s already registered by another provider — skipped (mutual exclusion)',
        tool.name,
      )
      return
    }
    tools.register(tool)
  }

  registerOnce(newsTool)
  registerOnce(derivativesTool)
  registerOnce(fundamentalsTool)

  // Issue #19：注册自定义指标创作工具 indicator_author（共享 ~/.dsh/indicators/custom.json）
  const indicatorStorePath = path.join(os.homedir(), '.dsh', 'indicators', 'custom.json')
  const authorStore = createFileCustomIndicatorStore(indicatorStorePath)
  registerOnce(createAuthorIndicatorTool({ store: authorStore }))

  // Issue #24：注册知识库摄取与检索工具（共享 ~/.dsh/knowledge/cards.json）
  const knowledgeStorePath = path.join(os.homedir(), '.dsh', 'knowledge', 'cards.json')
  const knowledgeStore = createFileKnowledgeCardStore(knowledgeStorePath)
  registerOnce(createKnowledgeIngestTool(knowledgeStore))
  registerOnce(createKnowledgeSearchTool(knowledgeStore))
}

/* ── crypto_get_news：加密新闻工具（WS1 #1） ───────────────────────────────────── */

const DEFAULT_NEWS_WINDOW_HOURS = 24
const DEFAULT_NEWS_LIMIT = 20

function renderNewsItem(item: { source: string; title: string; url: string; publishedAt: string }): string {
  return `[${item.source}] ${item.publishedAt}  ${item.title}\n  ${item.url}`
}

export function createGetNewsTool() {
  const description =
    'Get recent cryptocurrency news aggregated across multiple public no-key RSS/Atom feeds (CoinDesk, Cointelegraph, Decrypt, Bitcoin Magazine, Blockworks) and CryptoPanic public feed. '
    + 'Aggregates, deduplicates, and sorts newest-first; each item carries source name, publish time and a link for traceability. '
    + 'Optionally filter by coin/symbol (e.g. BTC, ETH, SOL) and by a time window. '
    + 'Source failures are tolerated and reported instead of failing the whole call. No credentials required.'
  return defineTool({
    name: 'crypto_get_news',
    description,
    parameters: {
      symbol: {
        type: 'string',
        description: 'Optional coin symbol or name to filter by (e.g. BTC, ETH, SOL, Bitcoin, Ethereum). Matched against item title.',
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
        return 'crypto_get_news: no news items found within the requested window.'
      }
      const symbolNote = options.symbol ? ` symbol=${options.symbol.trim().toUpperCase()}` : ''
      const lines = [
        `crypto_get_news — ${items.length} item(s)${symbolNote}, window=${options.windowHours ?? DEFAULT_NEWS_WINDOW_HOURS}h (newest-first):`,
        ...items.map(renderNewsItem),
      ]
      if (unavailable.length > 0) {
        lines.push('  (source(s) unavailable this call: ' + unavailable.join('; ') + ')')
      }
      return lines.join('\n')
    },
  })
}

/* ── crypto_get_derivatives：衍生品数据工具（WS1 #2） ───────────────────────── */

export function createGetDerivativesTool(options: { fetch?: typeof globalThis.fetch } = {}) {
  return defineTool({
    name: 'crypto_get_derivatives',
    description:
      'Get perpetual contract funding rate and open interest across Binance and OKX public endpoints. '
      + 'No credentials required. Accepts base/quote symbol (e.g. BTC-USDT, ETH-USDT, BTCUSDT).',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'Perpetual contract symbol, e.g. BTC-USDT, ETH-USDT, BTCUSDT',
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
        throw new Error('crypto_get_derivatives: symbol parameter is required (e.g. BTC-USDT)')
      }
      const result = await fetchCryptoDerivatives({ symbol, fetch: options.fetch })
      return renderDerivativesData(result, symbol)
    },
  })
}

/* ── crypto_get_fundamentals：加密基本面与链上数据工具（WS1 #3） ─────────────── */

export function createGetFundamentalsTool(options: { fetch?: typeof globalThis.fetch } = {}) {
  return defineTool({
    name: 'crypto_get_fundamentals',
    description:
      'Get fundamental data for a cryptocurrency (Market Cap, FDV, 24h Volume, Total Supply, Max Supply, Circulating Supply, ATH, ATL, DefiLlama TVL) via CoinGecko / CoinCap / DefiLlama public APIs. Accepts coin symbol or name (e.g. BTC, ETH, SOL, Bitcoin, Ethereum). No credentials required.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'Coin symbol or name, e.g. BTC, ETH, SOL, Bitcoin, Ethereum',
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
        throw new Error('crypto_get_fundamentals: symbol parameter is required (e.g. BTC or Ethereum)')
      }
      const result = await fetchCryptoFundamentals({ symbol, fetch: options.fetch })
      return renderCryptoFundamentals(result, symbol)
    },
  })
}
