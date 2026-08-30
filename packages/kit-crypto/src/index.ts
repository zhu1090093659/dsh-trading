/**
 * Crypto 工具箱插件（dsh-trading crypto 切片）。
 *
 * 两件事：
 *   1. skill provider：crypto-risk-checklist 随包分发（S2 形态；rank 用
 *      BUNDLED_SKILL_RANK=600，用户目录 100-500 天然覆盖之；skill 名市场前缀命名空间）；
 *   2. crypto_funding_rate 工具：Binance USDT 永续公共资金费率（独立 fetch，不经
 *      connector 服务，保持两包解耦；公共接口无凭证）。
 *
 * 插件本体不被 host 面挂载（架构修订）：两行在 crypto-trader preset 的
 * agent.cordis.yml 内，preset 级会话隔离——tools/skills 注册表按 scope 分层，注册只对
 * crypto-trader 会话可见，standard 会话看不到 crypto 工具。
 *
 * preset 自安装不在本插件（结构性修复 2026-08-29）：kit 行在 preset 平面，preset 不
 * 存在时 apply() 永不运行；自安装职责迁到 @dsh-trading/crypto bundle 的常驻安装器行
 * （dsh-trading-crypto-installer），preset 资产也随 bundle 分发。
 *
 * @module @dsh-trading/kit-crypto
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { aggregateNews, deriveSymbolTokens, type AggregateNewsOptions } from './news.js'

// ── skill provider（host 面 skill 全局可见即可，本切片不改 skill 作用域） ─────────

const PROVIDER_NAME = 'dsh-trading-crypto'

const SKILL_BODY_URL = new URL('../assets/skills/crypto-risk-checklist.md', import.meta.url)
const ANALYSIS_BODY_URL = new URL('../assets/skills/crypto-instrument-analysis.md', import.meta.url)
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

// WS3（docs/analysis-roadmap.md #5）：标的定性分析框架——五步流程对应工具与判读
// 规则；新闻面为占位（WS2b 的 crypto_get_news 交付后写实）。
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

const SKILL_CANDIDATES = [CANDIDATE, ANALYSIS_CANDIDATE]

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
  /** 交易安全闸门（铁律 #3）：与 connector 同词汇，kit 内未来交易辅助工具统一遵守。 */
  dryRun: boolean
  /** 实盘总闸门：默认 false。本切片 kit 工具只读公共数据，闸门随 preset 行声明保持一致。 */
  liveTrading: boolean
}

export const Config: Schema<Config> = Schema.object({
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
})

/** 需要宿主提供的 Cordis 服务。 */
export const inject = ['skills', 'tools']

/**
 * Cordis 插件名 = preset 行 id（TEMPLATES §8）：`dsh-trading-crypto-*` 市场命名空间，
 * 全仓唯一（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-crypto-kit'

// ── crypto_funding_rate：Binance USDT 永续资金费率（公共接口，独立 fetch） ──────

const FUNDING_RATE_URL = 'https://fapi.binance.com/fapi/v1/fundingRate'

/** Binance 合约符号形如 BTCUSDT / 1000PEPEUSDT：大写字母数字。 */
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

export function apply(ctx: Context, _config: Config): void {
  ctx.skills.registerProvider(() => provider)
  // duplicate-safe 注册（2026-08-29 okx 切片）：connector-okx 激活时也提供同名
  // crypto_funding_rate（OKX 词汇），同一组合内至多一家的工具生效——名字已被占用
  // （先挂载者先得，preset 挂载顺序 = 仲裁顺序）时跳过 + log 让位，而不是让 dsh-tools
  // 对重复注册抛错炸掉 preset 挂载。默认组合（okx enabled=false）本工具照常注册，行为不变。
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
          // 可选参数不写 required（dsh-tools schema 编译器：required 出现时必须为 true）。
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
  // duplicate-safe 注册：同名工具互斥（先到先得 + log 让位），不因单个名字被占而
  // 影响其它工具注册（否则 funding 让位会连带跳过 news）。
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

  // WS2b（docs/analysis-roadmap.md #3）：动态新闻工具——kit 内薄工具，直连公共源
  // （spike 推荐：四源均单端点无鉴权，无 connector 契约要素，故不进 dataplane/路由）。
  // 缺省无 key 全程可用；每源独立容错，输出带来源名 + 时间 + 链接（铁律 #5）。
  // WS2c（#4）：经 host 面 tradingMarketRouter 读设置 news.cryptoPanicKey——有值则
  // crypto_get_news 加测 CryptoPanic 免费层（B 增强）；无 router / 无 key 即公共源。
  const router = (ctx as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as
    | { newsKey?: () => string | undefined }
    | undefined
  registerOnce(createGetNewsTool({ cryptoPanicKey: router?.newsKey?.() }))
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
      const keyNote = options.cryptoPanicKey ? ' cryptopanicKey=set (B-source) ' : ''
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
