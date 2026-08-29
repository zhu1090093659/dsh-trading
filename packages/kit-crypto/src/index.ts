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

// ── skill provider（host 面 skill 全局可见即可，本切片不改 skill 作用域） ─────────

const PROVIDER_NAME = 'dsh-trading-crypto'

const SKILL_BODY_URL = new URL('../assets/skills/crypto-risk-checklist.md', import.meta.url)
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
  ctx.tools.register(
    defineTool({
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
    }),
  )
}
