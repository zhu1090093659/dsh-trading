/**
 * Crypto 工具箱插件骨架（dsh-trading crypto 切片）。
 *
 * Skill provider 注册形态参照官方 skill-badge：provider 注册进 ctx.skills，
 * skill 资产（assets/skills/*.md）随包分发。rank 用 BUNDLED_SKILL_RANK=600
 * （用户目录 100-500 天然覆盖之，S2 采纳建议）；skill 名用市场前缀命名空间（S2）。
 *
 * crypto 专属工具（资金费率、持仓量）与 crypto-trader preset 自安装在后续任务落地。
 *
 * @module @dsh-trading/kit-crypto
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

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

/**
 * Cordis 插件名 = patch 行 id（TEMPLATES §8）：`dsh-trading-crypto-*` 市场命名空间，
 * 全仓唯一（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-crypto-kit'

/** 需要宿主提供的 Cordis 服务。 */
export const inject = ['skills']

export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}

/**
 * TODO(第 1 阶段第 4 步，S3 机制)：crypto-trader preset 自安装。
 *
 * 预期行为：
 *   1. 把 assets/preset/crypto-trader/（agent.cordis.yml + preset.yml）幂等写入
 *      共享 preset root（~/.dsh-trading-presets，市场自有目录，不混入 ~/.dsh/.agent-presets）；
 *   2. preset 引用的插件必须已进市场 bundle dependencies，否则 preset 标 broken（S3 坑入账）；
 *   3. agents.create 的 setup 必须返回 undefined（S3 坑入账）。
 *
 * 脚手架阶段为空实现占位，不阻塞插件启动（尚未接线，apply 不调用）。
 */
export function installPreset(_ctx: Context): void {
  // 占位：见上方 TODO 注释。
}
