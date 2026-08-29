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
export const inject = ['skills']

/**
 * Cordis 插件名 = preset 行 id（TEMPLATES §8）：`dsh-trading-hk-*` 市场命名空间，
 * 全仓唯一（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-hk-kit'

// ── 插件入口 ──────────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Config): void {
  ctx.skills.registerProvider(() => provider)
}
