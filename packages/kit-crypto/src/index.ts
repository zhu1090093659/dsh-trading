/**
 * Crypto 工具箱插件（dsh-trading crypto 切片）。
 *
 * 包含：
 *   1. skill provider：crypto-risk-checklist、crypto-instrument-analysis、indicator-authoring、trading-strategy-paradigms、knowledge-curation 与 trading-notes-setup 随包分发；
 *   2. crypto_funding_rate（Binance 公共资金费率）；
 *   3. crypto_get_news（动态聚合新闻）；
 *   4. crypto_get_derivatives、crypto_get_derivatives_history 与 crypto_get_fundamentals 工具；
 *   5. indicator_author 创作工具（Issue #19）；
 *   6. knowledge_ingest 与 knowledge_search 知识库工具（Issue #24）。
 *
 * @module @dshtrading/kit-crypto
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
import type { DerivativesHistory, MarketDataService } from '@dshtrading/api'
import { aggregateNews, deriveSymbolTokens, type AggregateNewsOptions } from './news.js'
import { fetchCryptoDerivatives, renderDerivativesData } from './derivatives.js'
import { fetchCryptoFundamentals, renderCryptoFundamentals } from './fundamentals.js'

export * from './fundamentals.js'
export * from './derivatives.js'
export * from './news.js'

// ── skill provider（host 面 skill 全局可见即可，本切片不改 skill 作用域） ─────────

const PROVIDER_NAME = 'dsh-trading-crypto'

const SKILL_BODY_URL = new URL('../assets/skills/crypto-risk-checklist.md', import.meta.url)
const ANALYSIS_BODY_URL = new URL('../assets/skills/crypto-instrument-analysis.md', import.meta.url)
const AUTHORING_BODY_URL = new URL('../assets/skills/indicator-authoring.md', import.meta.url)
const STRATEGY_BODY_URL = new URL('../assets/skills/trading-strategy-paradigms.md', import.meta.url)
const KNOWLEDGE_CURATION_BODY_URL = new URL('../assets/skills/knowledge-curation.md', import.meta.url)
const JOURNAL_BODY_URL = new URL('../assets/skills/trading-notes-setup.md', import.meta.url)
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

const SKILL_CANDIDATES = [
  CANDIDATE,
  ANALYSIS_CANDIDATE,
  AUTHORING_CANDIDATE,
  STRATEGY_CANDIDATE,
  KNOWLEDGE_CURATION_CANDIDATE,
  JOURNAL_CANDIDATE,
]

export const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(SKILL_CANDIDATES),
  async get(candidate, _options): Promise<SkillDefinition> {
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
  /** 角色预设按需收窄技能面；缺省保持全量捆绑目录。 */
  skills?: string[]
}

export const Config: Schema<Config> = Schema.object({
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
  skills: Schema.array(Schema.string()),
})

export const inject = ['skills', 'tools']

export const name = 'dsh-trading-crypto-kit'

// ── crypto_funding_rate：Binance USDT 永续资金费率 ────────────────────────────

const FUNDING_RATE_URL = 'https://fapi.binance.com/fapi/v1/fundingRate'

const SYMBOL_PATTERN = /^[A-Z0-9]{4,20}$/
const DEFAULT_FUNDING_LIMIT = 3
const MAX_FUNDING_LIMIT = 1000

interface FundingRateRecord {
  symbol: string
  fundingTime: number
  fundingRate: string
  markPrice?: string
}

async function fetchFundingRates(symbol: string, limit: number): Promise<FundingRateRecord[]> {
  const url = new URL(FUNDING_RATE_URL)
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('limit', String(limit))
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Binance futures API error: HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ''}`)
  }
  const data: unknown = await response.json()
  if (!Array.isArray(data)) {
    throw new Error('Binance futures API returned an unexpected payload (expected an array of funding records)')
  }
  return data as FundingRateRecord[]
}

function renderFundingRates(symbol: string, records: FundingRateRecord[]): string {
  const lines = records.map((record) => {
    const rate = Number(record.fundingRate)
    const percent = Number.isFinite(rate) ? `${(rate * 100).toFixed(4)}%` : record.fundingRate
    const when = Number.isFinite(record.fundingTime) ? new Date(record.fundingTime).toISOString() : String(record.fundingTime)
    const mark = record.markPrice === undefined ? '' : `  markPrice=${record.markPrice}`
    return `- ${when}  rate=${record.fundingRate} (${percent})${mark}`
  })
  return [`crypto_funding_rate ${symbol} — last ${records.length} funding event(s):`, ...lines].join('\n')
}

// ── 插件入口 ──────────────────────────────────────────────────────────────────

/** 白名单视图：未知名 fail-fast 不静默缩面；白名单外的 get 拒绝分发。 */
export function providerForSkills(allowed?: readonly string[]): SkillProvider {
  if (!allowed) return provider
  const unknown = allowed.filter((name) => !SKILL_CANDIDATES.some((c) => c.name === name))
  if (unknown.length > 0) throw new Error(`[${PROVIDER_NAME}] unknown skills in whitelist: ${unknown.join(', ')}`)
  const active = SKILL_CANDIDATES.filter((c) => allowed.includes(c.name))
  return {
    name: provider.name,
    list: () => Promise.resolve(active),
    async get(candidate, options) {
      if (!active.some((c) => c.name === candidate.name)) throw new Error(`[${PROVIDER_NAME}] skill not in whitelist: ${candidate.name}`)
      return provider.get(candidate, options)
    },
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.skills.registerProvider(() => providerForSkills(config.skills))

  const fundingTool = defineTool({
    name: 'crypto_funding_rate',
    description:
      'Get recent funding rate history for a Binance USDⓈ-M perpetual futures symbol (public endpoint, no credentials). Returns the most recent funding events with rate and mark price.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'Perpetual futures symbol, e.g. BTCUSDT',
      },
      limit: {
        type: 'number',
        description: `Number of most recent funding events to return (1-${MAX_FUNDING_LIMIT}, default ${DEFAULT_FUNDING_LIMIT})`,
        default: DEFAULT_FUNDING_LIMIT,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { symbol?: unknown; limit?: unknown }
      const symbol = typeof args.symbol === 'string' ? args.symbol.trim().toUpperCase() : ''
      if (!SYMBOL_PATTERN.test(symbol)) {
        throw new Error(`crypto_funding_rate: invalid symbol ${JSON.stringify(args.symbol)} — expected an uppercase Binance futures symbol like BTCUSDT`)
      }
      const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : DEFAULT_FUNDING_LIMIT
      const limit = Math.min(Math.max(requested, 1), MAX_FUNDING_LIMIT)
      const records = await fetchFundingRates(symbol, limit)
      return renderFundingRates(symbol, records)
    },
  })

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

  registerOnce(fundingTool)

  const router = (ctx as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as
    | { newsKey?: () => string | undefined }
    | undefined
  registerOnce(createGetNewsTool({ cryptoPanicKey: router?.newsKey?.() }))

  registerOnce(createGetDerivativesTool())
  registerOnce(createGetFundamentalsTool())

  // issue #86 / 审计缺口卡 G8：crypto_get_derivatives_history —— 数据源是路由选中的
  // crypto 行情服务（registry-first，惰性解析：settings 切换 provider 即刻生效）。
  // 工具无条件注册，调用期裁决：registry 缺席/无激活 provider 抛 TRADING_NO_PROVIDER，
  // 服务缺可选方法抛 TRADING_NOT_IMPLEMENTED（绝不返回空数组冒充「无数据」）。
  registerOnce(createGetDerivativesHistoryTool({ getRegistry: () => resolveCryptoMarketDataRegistry(ctx) }))

  // issue #33 收口：indicator_author / knowledge_ingest / knowledge_search 已迁移至
  // @dshtrading/indicators/plugin 与 @dshtrading/knowledge/plugin（base patch 行，
  // host 平面单点注册）；crypto_get_indicators 由 connector-binance/okx 注册，kit 不重复。

  // 新闻聚合器注册到 host 面注册表（Issue #37）。
  // 注册表服务就绪时机不定，经 cordis inject 等待就绪后注册。kit 编译程序下
  // cordis Context 类型增强不完整（Context['inject'] 探针报缺），与同包 get 的
  // duck-type 处理一致。
  const lifecycle = ctx as unknown as {
    inject?: (deps: string[], callback: (scope: unknown) => void) => void
    effect?: (fn: () => void, name?: string) => void
  }
  lifecycle.inject?.(['tradingNewsRegistry'], (scope) => {
    const registry = (scope as { tradingNewsRegistry?: { register(market: string, aggregator: unknown): () => void } }).tradingNewsRegistry
    if (registry && typeof registry.register === 'function') {
      lifecycle.effect?.(() => registry.register('crypto', aggregateNews), 'kit-crypto news registration')
    }
  })
}

/* ── crypto_get_derivatives：衍生品数据工具（WS4） ───────────────────────────── */

export function createGetDerivativesTool(options: { fetch?: typeof globalThis.fetch } = {}) {
  return defineTool({
    name: 'crypto_get_derivatives',
    description:
      'Get real-time crypto derivatives indicators (Open Interest, Long/Short Account Ratio, Top Trader Position Ratio, Taker Buy/Sell Volume Ratio, and latest Funding Rate) for a perpetual contract via Binance Futures public REST API. Accepts market-canonical (e.g. BTCUSDT, BTCUSDT-SWAP) or native symbols. No credentials required.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'Perpetual contract symbol, market-canonical vocabulary, e.g. BTCUSDT or BTCUSDT-SWAP',
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
        throw new Error('crypto_get_derivatives: symbol parameter is required (e.g. BTCUSDT or BTCUSDT-SWAP)')
      }
      const result = await fetchCryptoDerivatives({ symbol, fetch: options.fetch })
      return renderDerivativesData(result, symbol)
    },
  })
}

/* ── crypto_get_derivatives_history：路由行情服务的衍生品历史序列（#86 / G8） ─────── */

const DERIVATIVES_HISTORY_MIN_LIMIT = 1
const DERIVATIVES_HISTORY_MAX_LIMIT = 200

/** 行情注册表最小形状（与 @dshtrading/router 的 MarketDataRegistryLike 同构）。 */
interface CryptoMarketDataRegistry {
  active(market: string): { provider: string; service: MarketDataService } | undefined
}

/** registry-first 解析（惰性：每次调用重新读取，路由切换即刻生效；老部署无此服务则 undefined）。 */
function resolveCryptoMarketDataRegistry(ctx: Context): CryptoMarketDataRegistry | undefined {
  return (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false) as
    | CryptoMarketDataRegistry
    | undefined
}

function parseDerivativesHistoryLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(
      `crypto_get_derivatives_history: invalid limit ${JSON.stringify(raw)} — limit must be a number in ${DERIVATIVES_HISTORY_MIN_LIMIT}..${DERIVATIVES_HISTORY_MAX_LIMIT}`,
    )
  }
  const limit = Math.trunc(raw)
  if (limit < DERIVATIVES_HISTORY_MIN_LIMIT || limit > DERIVATIVES_HISTORY_MAX_LIMIT) {
    throw new Error(
      `crypto_get_derivatives_history: invalid limit ${raw} — limit must be in ${DERIVATIVES_HISTORY_MIN_LIMIT}..${DERIVATIVES_HISTORY_MAX_LIMIT}`,
    )
  }
  return limit
}

/**
 * 衍生品历史序列工具（只读）。数据源恒为路由选中的 crypto 行情服务，不直连交易所：
 * 与 crypto_get_derivatives 的硬编码 Binance 数据源不一致（审计既存项）有意不复刻。
 */
export function createGetDerivativesHistoryTool(options: { getRegistry: () => CryptoMarketDataRegistry | undefined }) {
  return defineTool({
    name: 'crypto_get_derivatives_history',
    description:
      'Read-only. Get the derivatives history series for a crypto perpetual contract — funding-rate history and open-interest history, both time-ascending (oldest first) — '
      + 'from the currently routed crypto market data provider (registry-first; never a hardcoded exchange). '
      + 'The returned symbol is the provider-canonical form. '
      + `Optional limit keeps only the most recent N points per series (${DERIVATIVES_HISTORY_MIN_LIMIT}-${DERIVATIVES_HISTORY_MAX_LIMIT}) and reports truncatedTo. `
      + 'If the routed provider does not implement getDerivativesHistory the call fails with TRADING_NOT_IMPLEMENTED — an empty series is never substituted for "no data"; '
      + 'if no crypto provider is routed it fails with TRADING_NO_PROVIDER.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'Perpetual contract symbol, market-canonical vocabulary, e.g. BTCUSDT or BTCUSDT-SWAP',
      },
      limit: {
        type: 'number',
        description: `Keep only the most recent N points per series (${DERIVATIVES_HISTORY_MIN_LIMIT}-${DERIVATIVES_HISTORY_MAX_LIMIT}). Omit to return the provider's full series.`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { symbol?: unknown; limit?: unknown }
      const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : ''
      if (!symbol) {
        throw new Error('crypto_get_derivatives_history: symbol parameter is required (e.g. BTCUSDT or BTCUSDT-SWAP)')
      }
      const limit = parseDerivativesHistoryLimit(args.limit)

      const entry = options.getRegistry()?.active('crypto')
      if (entry === undefined) {
        throw new Error(
          'crypto_get_derivatives_history: TRADING_NO_PROVIDER — no crypto market data provider is active (market data registry absent, or no crypto provider installed/routed)',
        )
      }
      const getHistory = entry.service.getDerivativesHistory
      if (typeof getHistory !== 'function') {
        throw new Error(
          `crypto_get_derivatives_history: TRADING_NOT_IMPLEMENTED — provider ${entry.provider} does not implement getDerivativesHistory (this is not "no data")`,
        )
      }

      const returned = (await getHistory.call(entry.service, symbol)) as unknown
      if (returned === null || typeof returned !== 'object') {
        throw new Error(`crypto_get_derivatives_history: provider ${entry.provider} returned an invalid derivatives history payload`)
      }
      const history = returned as DerivativesHistory

      // truncatedTo 只在**真的截断**时回显（2026-09-08 审查 P2-5）：此前无条件等于请求
      // 的 limit，4 点序列 + limit=200 会让模型报「已截断到 200 条」。
      const longest = Math.max(history.fundingRates?.length ?? 0, history.openInterest?.length ?? 0)
      const truncated = limit !== undefined && longest > limit
      const result: {
        ok: true
        market: 'crypto'
        provider: string
        symbol: string
        history: DerivativesHistory
        truncated: boolean
        truncatedTo?: number
      } = {
        ok: true,
        market: 'crypto',
        provider: entry.provider,
        symbol: typeof history.symbol === 'string' && history.symbol !== '' ? history.symbol : symbol,
        history,
        truncated,
      }
      if (truncated && limit !== undefined) {
        result.truncatedTo = limit
        result.history = {
          ...history,
          ...(history.fundingRates === undefined ? {} : { fundingRates: history.fundingRates.slice(-limit) }),
          ...(history.openInterest === undefined ? {} : { openInterest: history.openInterest.slice(-limit) }),
        }
      }
      return JSON.stringify(result)
    },
  })
}

/* ── crypto_get_fundamentals：代币经济学与基本面工具（WS4） ───────────────────── */

export function createGetFundamentalsTool(options: { fetch?: typeof globalThis.fetch } = {}) {
  return defineTool({
    name: 'crypto_get_fundamentals',
    description:
      'Get tokenomics and fundamental data (Market Cap Rank, Market Cap, Fully Diluted Valuation (FDV), Circulating Supply, Max Supply, 24h Volume and Price Change) for a crypto asset via CoinCap and Binance public REST APIs. Accepts symbol (BTCUSDT) or asset ticker (BTC). No credentials required.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'Crypto symbol or asset ticker, e.g. BTCUSDT, BTC, ETH, SOL',
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
        throw new Error('crypto_get_fundamentals: symbol parameter is required (e.g. BTCUSDT or BTC)')
      }
      const result = await fetchCryptoFundamentals({ symbol, fetch: options.fetch })
      return renderCryptoFundamentals(result, symbol)
    },
  })
}

/* ── crypto_get_news：动态新闻工具（WS2b，#3） ───────────────────────────────── */

const DEFAULT_NEWS_WINDOW_HOURS = 24
const DEFAULT_NEWS_LIMIT = 20

function renderNewsItem(item: { source: string; title: string; url: string; publishedAt: string }): string {
  return `[${item.source}] ${item.publishedAt}  ${item.title}\n  ${item.url}`
}

export function createGetNewsTool(toolOptions: { cryptoPanicKey?: string } = {}) {
  const description =
    'Get recent crypto news from public no-key sources (Binance listing/delisting/API announcements, OKX announcements, CoinDesk & The Block RSS). '
    + (toolOptions.cryptoPanicKey
      ? 'CryptoPanic user key is set — the CryptoPanic free tier is queried as an additional source and degrades gracefully if it fails. '
      : '')
    + 'Aggregates and sorts newest-first; each item carries source name, publish time and a link for traceability. '
    + 'Optionally filter by symbol (matched against item titles; note media headlines often use asset names like "Bitcoin" rather than tickers) and by a time window. '
    + 'Source failures are tolerated and reported instead of failing the whole call. No credentials required. Distinguish announcements (listing, delisting, regulatory) from opinion (media) when citing.'
  return defineTool({
    name: 'crypto_get_news',
    description,
    parameters: {
      symbol: {
        type: 'string',
        description: 'Optional symbol to filter by, market-canonical vocabulary, e.g. BTCUSDT or BTCUSDT-SWAP. Matched against item titles (case-insensitive substring of the symbol or its base asset).',
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
        cryptoPanicKey: toolOptions.cryptoPanicKey,
      }
      const { items, unavailable } = await aggregateNews(options)
      if (items.length === 0 && unavailable.length === 0) {
        return 'crypto_get_news: no news items found within the requested window.'
      }
      const symbolNote = options.symbol ? ` symbol=${options.symbol.trim().toUpperCase()} (tokens: ${deriveSymbolTokens(options.symbol).join(', ')})` : ''
      const keyNote = options.cryptoPanicKey ? ' cryptopanicKey=set (B-source)' : ''
      const lines = [
        `crypto_get_news — ${items.length} item(s)${symbolNote}${keyNote}, window=${options.windowHours ?? DEFAULT_NEWS_WINDOW_HOURS}h (newest-first):`,
        ...items.map(renderNewsItem),
      ]
      if (unavailable.length > 0) {
        lines.push('  (source(s) unavailable this call: ' + unavailable.join('; ') + ')')
      }
      return lines.join('\n')
    },
  })
}
