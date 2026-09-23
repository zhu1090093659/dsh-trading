import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider, type SkillResourceBase } from '@deepseek-ai/dsh-skill'
export const name = 'dsh-trading-role-skills'
export const inject = ['skills']
const companyResourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/company-analysis/', import.meta.url)) } as const
const flatResourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/', import.meta.url)) } as const
const weeklyPlanResourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/weekly-trading-plan/', import.meta.url)) } as const
/** Concrete candidate: this provider always supplies resourceBase and a URL locator. */
type RoleCandidate = SkillCandidate & { resourceBase: SkillResourceBase; locator: URL }
const CANDIDATES: RoleCandidate[] = [
  {
    name: 'company-analysis',
    description: '上市公司研究：先按价值驱动分类，再核验公告财报、财务质量、估值与反方情景；含周期股跨周期校准。',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    resourceBase: companyResourceBase,
    rank: BUNDLED_SKILL_RANK,
    locator: new URL('../assets/skills/company-analysis/SKILL.md', import.meta.url),
  },
  {
    name: 'weekly-trading-plan',
    description: '每周交易计划：把本周复盘、持仓与资金、消息与公告、facts/ 与知识库、假设档案合成下周计划，按交易模式 A/B、分市场策略与 KDAS 买点分层逐条过六道闸门，输出双向预案与失效条件。',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    resourceBase: weeklyPlanResourceBase,
    rank: BUNDLED_SKILL_RANK,
    locator: new URL('../assets/skills/weekly-trading-plan/SKILL.md', import.meta.url),
  },
  {
    name: 'dynamic-capabilities',
    description: '一次性批量计算/跨标的聚合与可复用小工具的官方通路指南：0.1.7 宿主已移除 cordis_define/cordis_run 动态包，一次性需求用 bash 跑即弃脚本，可复用助手走官方 cordis preset + Plugin Manager 持久化插件；含优先关系与交易安全边界（禁止规避下单闸门）。',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    resourceBase: flatResourceBase,
    rank: BUNDLED_SKILL_RANK,
    locator: new URL('../assets/skills/dynamic-capabilities.md', import.meta.url),
  },
]
export const provider: SkillProvider = {
  name,
  list: async () => CANDIDATES,
  async get(requested, _options) {
    const candidate = CANDIDATES.find(c => c.name === requested.name)
    if (!candidate) throw new Error(`Unknown role skill: ${requested.name}`)
    return { name: candidate.name, description: candidate.description, invocation: candidate.invocation,
      provider: name, source: 'bundled', resourceBase: candidate.resourceBase, content: await readFile(candidate.locator, 'utf8') }
  },
}
export interface Config { skills?: string[] | null }
export const Config: Schema<Config> = Schema.object({
  // Missing must stay undefined: Schema.array() normalizes an absent field to [],
  // which providerForSkills() reads as an explicit empty whitelist.
  skills: Schema.union([Schema.array(Schema.string()), Schema.const(null)]).default(null),
})
/** Whitelist view for role presets; unknown names fail fast instead of silently shrinking the surface. */
export function providerForSkills(allowed?: readonly string[] | null): SkillProvider {
  if (!allowed) return provider
  const unknown = allowed.filter(skill => !CANDIDATES.some(c => c.name === skill))
  if (unknown.length) throw new Error(`Unknown role skills: ${unknown.join(', ')}`)
  const active = CANDIDATES.filter(c => allowed.includes(c.name))
  return {
    name,
    list: () => Promise.resolve(active),
    async get(requested, options) {
      if (!active.some(c => c.name === requested.name)) throw new Error(`Unknown role skill: ${requested.name}`)
      return provider.get(requested, options)
    },
  }
}
export function apply(ctx: Context, config: Config): void { ctx.skills.registerProvider(() => providerForSkills(config.skills)) }
