import { describe, expect, it } from 'vitest'
import { Config, provider, providerForSkills } from '../src/role-skills.js'

describe('dsh-trading-role-skills provider', () => {
  it('bundles company-analysis, weekly-trading-plan, dynamic-capabilities and content-insight with readable bodies', async () => {
    const candidates = await provider.list()
    expect(candidates.map(c => c.name)).toEqual(['company-analysis', 'weekly-trading-plan', 'dynamic-capabilities', 'content-insight'])
    for (const candidate of candidates) {
      const skill = await provider.get(candidate)
      expect(skill.name).toBe(candidate.name)
      expect(skill.provider).toBe('dsh-trading-role-skills')
      expect(skill.source).toBe('bundled')
      expect(skill.content.length).toBeGreaterThan(100)
    }
    const company = await provider.get({ name: 'company-analysis' })
    expect(company.content).toContain('company-analysis')

    // Packaged skill body must survive the sync step (fetched from the portable directory).
    const plan = await provider.get({ name: 'weekly-trading-plan' })
    expect(plan.content).toContain('KDAS')
    expect(plan.content).toContain('六道闸门')

    // content-insight is portable too: the body loads from its own directory and the
    // resourceBase must point there so the pipeline scripts resolve inside the package.
    const insight = await provider.get({ name: 'content-insight' })
    expect(insight.content).toContain('whisper_asr.py')
    const insightBase = insight.resourceBase
    expect(insightBase?.kind).toBe('directory')
    expect(insightBase && insightBase.kind === 'directory' ? insightBase.path : '').toMatch(/assets[\\/]skills[\\/]content-insight[\\/]?$/)
  })

  it('rejects unknown role skills', async () => {
    await expect(provider.get({ name: 'no-such-skill' })).rejects.toThrow('Unknown role skill')
  })

  it('scopes the catalog by whitelist, rejects whitelist misses and unknown names', async () => {
    const scoped = providerForSkills(['company-analysis'])
    expect((await scoped.list()).map(c => c.name)).toEqual(['company-analysis'])
    expect((await scoped.get({ name: 'company-analysis' })).name).toBe('company-analysis')
    await expect(scoped.get({ name: 'dynamic-capabilities' })).rejects.toThrow('Unknown role skill')
    expect(() => providerForSkills(['no-such-skill'])).toThrow('Unknown role skills')
    expect(providerForSkills()).toBe(provider) // absent whitelist keeps the full catalog
  })

  it('parses a missing whitelist as "no whitelist" rather than an empty catalog', async () => {
    // Regression: the schema once normalized an absent field to [], so the master
    // preset's role-skills provider registered zero bundled skills.
    const parsed = Config({})
    expect(parsed.skills).toBeUndefined()
    expect(providerForSkills(parsed.skills)).toBe(provider)

    const empty = Config({ skills: [] })
    expect(empty.skills).toEqual([])
    expect(await providerForSkills(empty.skills).list()).toEqual([])
  })

  it('user gets a fail-fast rejection for an unknown whitelist name instead of a silently shrunk surface', () => {
    // Given: a whitelist mixing a known skill with a name no candidate provides
    let scoped: ReturnType<typeof providerForSkills> | undefined
    // When: the whitelist view is built for that list
    // Then: it fails fast — never an empty surface, never a quiet "known names only" subset
    expect(() => {
      scoped = providerForSkills(['company-analysis', 'no-such-skill'])
    }).toThrow('Unknown role skills: no-such-skill')
    expect(scoped).toBeUndefined()
  })
})
