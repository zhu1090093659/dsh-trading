import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
export const name = 'dsh-trading-role-skills'
export const inject = ['skills']
const resourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/company-analysis/', import.meta.url)) } as const
const candidate: SkillCandidate = {
  name: 'company-analysis',
  description: '上市公司研究：先按价值驱动分类，再核验公告财报、财务质量、估值与反方情景；含周期股跨周期校准。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: name,
  source: 'bundled',
  resourceBase,
  rank: BUNDLED_SKILL_RANK,
  locator: new URL('../assets/skills/company-analysis/SKILL.md', import.meta.url),
}
export const provider: SkillProvider = {
  name,
  list: async () => [candidate],
  async get(requested) {
    if (requested.name !== candidate.name) throw new Error(`Unknown role skill: ${requested.name}`)
    return { name: candidate.name, description: candidate.description, invocation: candidate.invocation,
      provider: name, source: 'bundled', resourceBase, content: await readFile(candidate.locator, 'utf8') }
  },
}
export function apply(ctx: Context): void { ctx.skills.registerProvider(() => provider) }
