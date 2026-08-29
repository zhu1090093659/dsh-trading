/**
 * Crypto 工具箱插件（dsh-trading crypto 切片）。
 *
 * 三件事：
 *   1. skill provider：crypto-risk-checklist 随包分发（S2 形态；rank 用
 *      BUNDLED_SKILL_RANK=600，用户目录 100-500 天然覆盖之；skill 名市场前缀命名空间）；
 *   2. crypto_funding_rate 工具：Binance USDT 永续公共资金费率（独立 fetch，不经
 *      connector 服务，保持两包解耦；公共接口无凭证）；
 *   3. crypto-trader preset 幂等自安装（S3 机制）：apply() 把 assets/preset/crypto-trader/
 *      写入市场自有 root（默认 ~/.dsh-trading-presets），插件卸载不删除。
 *
 * 插件本体不再被 host 面挂载（架构修订）：两行在 preset 的 agent.cordis.yml 内，
 * preset 级会话隔离——tools/skills 注册表按 scope 分层，注册只对 crypto-trader 会话可见，
 * standard 会话看不到 crypto 工具。
 *
 * @module @dsh-trading/kit-crypto
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
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
  /** preset 自安装 root 覆盖；默认 ~/.dsh-trading-presets（市场自有目录，不混入 ~/.dsh）。 */
  presetRoot?: string
}

export const Config: Schema<Config> = Schema.object({
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
  presetRoot: Schema.string(),
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

// ── crypto-trader preset 幂等自安装（S3 机制） ─────────────────────────────────

export const PRESET_ID = 'crypto-trader'

/** 默认安装 root：市场自有目录（S3 建议——绝不写进 ~/.dsh/.agent-presets 用户创作区）。 */
export const DEFAULT_PRESET_ROOT = join(homedir(), '.dsh-trading-presets')

const PRESET_ASSET_DIR = fileURLToPath(new URL('../assets/preset/', import.meta.url))
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const

export interface SelfInstallResult {
  /** 安装目录（preset 目录名即 roster id）。 */
  dir: string
  /** 本次实际写入的文件名；空数组 = 目录已是最新的幂等运行。 */
  wrote: string[]
}

/**
 * 幂等自安装 crypto-trader preset（S3 机制，参照 spikes/s3-preset/spike-preset-pkg 的
 * selfInstall）：mkdir -p + 逐文件内容 diff 后写，内容一致则零写入。
 *
 * 卸载本插件不删除已安装目录（有意为之）：升级/重装后再次 apply 即恢复一致；本包被移除后
 * preset 行不可解析只会得到带原因的 broken 行，无进程崩溃（S3 REPORT broken 语义）。
 * preset 引用的插件包必须进 @dsh-trading/crypto 的 dependencies（S3 坑 3），已由 bundle 保证。
 */
export async function installPreset(options: { presetRoot?: string } = {}): Promise<SelfInstallResult> {
  const dir = join(options.presetRoot ?? DEFAULT_PRESET_ROOT, PRESET_ID)
  await mkdir(dir, { recursive: true })
  const wrote: string[] = []
  for (const file of PRESET_FILES) {
    const content = await readFile(join(PRESET_ASSET_DIR, PRESET_ID, file), 'utf8')
    const target = join(dir, file)
    let current: string | null = null
    try {
      current = await readFile(target, 'utf8')
    } catch {
      // 不存在（首次安装）或不可读 → 视为需要写入。
    }
    if (current !== content) {
      await writeFile(target, content)
      wrote.push(file)
    }
  }
  return { dir, wrote }
}

// ── 插件入口 ──────────────────────────────────────────────────────────────────

/** 宿主 logger 的最小形状（ctx.logger(name) 不可用时回落 console，保证任何面可启动）。 */
interface LogLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

function logger(ctx: Context): LogLike {
  const service = (ctx as unknown as { logger?: (name: string) => LogLike }).logger
  return typeof service === 'function' ? service(name) : console
}

export function apply(ctx: Context, config: Config): void {
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

  // 自安装不阻塞插件启动、失败不炸 preset 挂载（fire-and-forget，日志留痕）。
  void installPreset({ presetRoot: config.presetRoot }).then(
    (result) => logger(ctx).info(
      '[dsh-trading-crypto-kit] self-install %s preset at %s wrote=[%s]',
      PRESET_ID,
      result.dir,
      result.wrote.join(',') || 'nothing — already current',
    ),
    (error: unknown) => logger(ctx).warn('[dsh-trading-crypto-kit] crypto-trader preset self-install failed: %s', error),
  )
}
