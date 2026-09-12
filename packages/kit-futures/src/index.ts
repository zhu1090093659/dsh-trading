/**
 * 期货工具箱插件（dsh-trading futures 切片，issue #97）。
 *
 * 当前能力：skill provider —— futures-risk-checklist 随包分发（保证金/杠杆/
 * 强平/交割/夜盘风控清单）。行情数据由 @dshtrading/connector-hithink/futures
 * 提供（tradingFuturesMarketData），本插件不重复 provide。
 *
 * @module @dshtrading/kit-futures
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

const PROVIDER_NAME = 'dsh-trading-futures'

const SKILL_BODY_URL = new URL('../assets/skills/futures-risk-checklist.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/skills/', import.meta.url)),
} as const

const RISK_CHECKLIST_CANDIDATE: SkillCandidate = {
  name: 'futures-risk-checklist',
  description: '期货交易风控检查清单：开仓前逐项核对保证金与杠杆、强平与追保线、合约到期与移仓换月、夜盘时段与隔夜跳空、涨跌停板流动性、品种主力合约切换。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const SKILL_CANDIDATES = [RISK_CHECKLIST_CANDIDATE]

export const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(SKILL_CANDIDATES),
  async get(candidate, _options): Promise<SkillDefinition> {
    const target = SKILL_CANDIDATES.find((c) => c.name === candidate.name) ?? RISK_CHECKLIST_CANDIDATE
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

export const inject = ['skills']

export const name = 'dsh-trading-futures-kit'

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
}
