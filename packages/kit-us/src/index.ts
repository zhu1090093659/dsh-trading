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
export const inject = ['skills']

/**
 * Cordis 插件名 = preset 行 id（TEMPLATES §8）：`dsh-trading-us-*` 市场命名空间，
 * 全仓唯一（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-us-kit'

// ── 插件入口 ──────────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Config): void {
  ctx.skills.registerProvider(() => provider)
}
