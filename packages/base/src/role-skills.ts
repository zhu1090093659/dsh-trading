import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider, type SkillResourceBase } from '@deepseek-ai/dsh-skill'
export const name = 'dsh-trading-role-skills'
export const inject = ['skills']
const companyResourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/company-analysis/', import.meta.url)) } as const
const flatResourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/', import.meta.url)) } as const
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
    name: 'dynamic-capabilities',
    description: 'dsh-tool-cordis 动态包使用指南：何时用 cordis_define/cordis_run 定义一次性动态包（临时批量计算、跨标的聚合分析等数据型需求），何时不用；信任级、生命周期与安全边界（禁止规避下单闸门、浏览器半必须人工审批）。',
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
export interface Config { skills?: string[] }
export const Config: Schema<Config> = Schema.object({ skills: Schema.array(Schema.string()) })
/** Whitelist view for role presets; unknown names fail fast instead of silently shrinking the surface. */
export function providerForSkills(allowed?: readonly string[]): SkillProvider {
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
