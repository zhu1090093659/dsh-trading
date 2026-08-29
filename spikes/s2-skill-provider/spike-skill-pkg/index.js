/**
 * S2 spike: a third-party npm package that distributes a skill by registering
 * a SkillProvider on ctx.skills, mimicking @deepseek-ai/dsh-skill-badge
 * (packages/skill/skill-badge/src/index.ts). Plain JS on purpose: the provider
 * is a plain object, no build step, no runtime imports from DSH packages.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PROVIDER_NAME = 'spike-s2-pkg'
const SKILL_BODY_URL = new URL('./assets/spike-s2-hello.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('./assets/', import.meta.url)),
} /* as const */
const INVOCATION = { modelInvocable: true, userInvocable: true } /* as const */
const DESCRIPTION =
  'S2 spike skill shipped inside an out-of-tree npm package. Use when the user asks to ' +
  'prove that a package-registered skill provider works, or mentions spike-s2-hello.'
// 600 == BUNDLED_SKILL_RANK (packages/skill/skill/src/index.ts:27); hardcoded
// to keep this package dependency-free. Type-only imports of
// '@deepseek-ai/dsh-skill' would be the typed real-world equivalent.
const RANK = 600

const CANDIDATE = {
  name: 'spike-s2-hello',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: RANK,
  locator: SKILL_BODY_URL,
}

const provider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate) {
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

/** Cordis plugin name. */
export const name = 'spike-skill-pkg'
/** Service required by the provider. */
export const inject = ['skills']

/** Register the provider on ctx.skills, synchronously during apply(). */
export function apply(ctx) {
  ctx.skills.registerProvider(() => provider)
}
