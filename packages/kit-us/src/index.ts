/**
 * US 工具箱插件（dsh-trading us 切片，模板 = kit-crypto commit af5cfff）。
 *
 * 一件事：skill provider——us-risk-checklist 随包分发（S2 形态；rank 用
 * BUNDLED_SKILL_RANK=600，用户目录 100-500 天然覆盖之；skill 名市场前缀命名空间）。
 * us 市场无需资金费率类工具（现货/股票无永续资金费），当前无附加工具。
 *
 * 插件本体不被 host 面挂载（架构修订，与 kit-crypto 同款）：本行在 us-trader preset 的
 * agent.cordis.yml 内，preset 级会话隔离——skill 注册表按 scope 分层，注册只对
 * us-trader 会话可见，standard 会话看不到 us-* skill。
 *
 * preset 自安装不在本插件（结构性修复 2026-08-29）：kit 行在 preset 平面，preset 不
 * 存在时 apply() 永不运行；自安装职责在 @dsh-trading/us bundle 的常驻安装器行
 * （dsh-trading-us-installer），preset 资产也随 bundle 分发。
 *
 * @module @dsh-trading/kit-us
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
import { aggregateNews, type AggregateNewsOptions } from './news.js'

// ── skill provider（host 面 skill 全局可见即可，本切片不改 skill 作用域） ─────────

const PROVIDER_NAME = 'dsh-trading-us'

const SKILL_BODY_URL = new URL('../assets/skills/us-risk-checklist.md', import.meta.url)
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

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

// ── 插件配置 ──────────────────────────────────────────────────────────────────

export interface Config {
  /** 交易安全闸门（铁律 #3）：与 connector 同词汇，kit 内未来交易辅助工具统一遵守。 */
  dryRun: boolean
  /** 实盘总闸门：默认 false。本切片 kit 只分发知识（skill），闸门随 preset 行声明保持一致。 */
  liveTrading: boolean
}

export const Config: Schema<Config> = Schema.object({
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
})

/** 需要宿主提供的 Cordis 服务。 */
export const inject = ['skills', 'tools']

/**
 * Cordis 插件名 = preset 行 id（TEMPLATES §8）：`dsh-trading-us-*` 市场命名空间，
 * 全仓唯一（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-us-kit'

// ── 插件入口 ──────────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Config): void {
  ctx.skills.registerProvider(() => provider)

  // WS4 #1（#6）：us_get_news——kit 内薄工具，直连公共源（spike 推荐：Yahoo + Google RSS 均单端点无鉴权，
  // 无 connector 契约要素）。缺省无 key 全程可用；每源独立容错，输出带来源名 + 时间 + 链接（铁律 #5）。
  const newsTool = createGetNewsTool()
  const tools = ctx.tools as unknown as {
    register(definition: { name: string }): unknown
    get(name: string): { name: string } | undefined
  }
  if (tools.get(newsTool.name) !== undefined) {
    ctx.logger('dsh-trading-us-kit').info(
      '[dsh-trading-us-kit] tool %s already registered by another provider — skipped (mutual exclusion)',
      newsTool.name,
    )
    return
  }
  tools.register(newsTool)
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
