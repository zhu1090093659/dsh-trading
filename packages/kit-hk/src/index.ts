/**
 * HK（港股）工具箱插件（dsh-trading cn+hk 双市场切片，模板 = kit-us/kit-cn）。
 *
 * 一件事：skill provider——hk-risk-checklist 随包分发（S2 形态；rank 用
 * BUNDLED_SKILL_RANK=600，用户目录 100-500 天然覆盖之；skill 名市场前缀命名空间）。
 *
 * 插件本体不被 host 面挂载（架构修订，与 kit-crypto/kit-us 同款）：本行在 hk-trader
 * preset 的 agent.cordis.yml 内，preset 级会话隔离——skill 注册表按 scope 分层。
 * preset 自安装不在本插件（在 @dsh-trading/hk bundle 的常驻安装器行）。
 *
 * @module @dsh-trading/kit-hk
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

// ── skill provider ────────────────────────────────────────────────────────────

const PROVIDER_NAME = 'dsh-trading-hk'

const SKILL_BODY_URL = new URL('../assets/skills/hk-risk-checklist.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/skills/', import.meta.url)),
} as const

const CANDIDATE: SkillCandidate = {
  name: 'hk-risk-checklist',
  description: '港股交易风控检查清单：开仓前逐项核对 T+0 回转与无涨跌幅限制、碎股（board lot）与手数、供股/配股摊薄、窝轮牛熊证杠杆与强制收回、港元汇率与港股通差异。',
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
 * Cordis 插件名 = preset 行 id（TEMPLATES §8）：`dsh-trading-hk-*` 市场命名空间，
 * 全仓唯一（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-hk-kit'

// ── 插件入口 ──────────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Config): void {
  ctx.skills.registerProvider(() => provider)

  // WS4 #1（#6）：hk_get_news——降级方案（用户裁决 2026-08-30）：东财快讯第 103 列 + 116. 港股代码/关键词过滤，
  // 诚实标注覆盖不纯（统一 CN 金融流、无干净港股公共源）。铁律 #5 只引元数据，不取正文。
  const newsTool = createGetNewsTool()
  const tools = ctx.tools as unknown as {
    register(definition: { name: string }): unknown
    get(name: string): { name: string } | undefined
  }
  if (tools.get(newsTool.name) !== undefined) {
    ctx.logger('dsh-trading-hk-kit').info(
      '[dsh-trading-hk-kit] tool %s already registered by another provider — skipped (mutual exclusion)',
      newsTool.name,
    )
    return
  }
  tools.register(newsTool)
}

/* ── hk_get_news：港股新闻工具（WS4 #1，#6 降级） ────────────────────────────── */

const DEFAULT_NEWS_WINDOW_HOURS = 24
const DEFAULT_NEWS_LIMIT = 20

function renderNewsItem(item: { source: string; title: string; url: string; publishedAt: string }): string {
  return `[${item.source}] ${item.publishedAt}  ${item.title}\n  ${item.url}`
}

export function createGetNewsTool() {
  const description =
    'Get recent Hong Kong stock market news, derived from Eastmoney financial fast-news (HK column) filtered to HK-relevant items '
    + '(HKEX-listed marketId=116 codes or HK keywords). '
    + 'DEGRADED SOURCE — Eastmoney is a unified CN financial feed; HK coverage is PARTIAL (HK news without an HK-listed code or HK keyword is not captured; not a dedicated HK news source). '
    + 'Each item carries source name (东方财富), publish time and a link for traceability; fetches metadata only, never redistributes article bodies. '
    + 'Optionally filter by symbol (HK code, e.g. 00700 / 00700.HK) and by a time window. No credentials required.'
  return defineTool({
    name: 'hk_get_news',
    description,
    parameters: {
      symbol: {
        type: 'string',
        description: 'Optional symbol to filter by, market-canonical vocabulary, e.g. 00700 or 00700.HK (Tencent). Best-effort matched against HK-listed stock codes.',
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
        return 'hk_get_news: no news items found within the requested window (degraded source: Eastmoney HK column may have no HK-relevant items in-window).'
      }
      const symbolNote = options.symbol ? ` symbol=${options.symbol.trim()}` : ''
      const lines = [
        `hk_get_news — ${items.length} item(s)${symbolNote}, window=${options.windowHours ?? DEFAULT_NEWS_WINDOW_HOURS}h (newest-first; DEGRADED — Eastmoney HK column, partial HK coverage):`,
        ...items.map(renderNewsItem),
      ]
      if (unavailable.length > 0) {
        lines.push('  (source(s) unavailable this call: ' + unavailable.join('; ') + ')')
      }
      return lines.join('\n')
    },
  })
}
