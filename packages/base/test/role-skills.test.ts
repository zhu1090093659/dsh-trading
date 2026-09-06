import { describe, expect, it } from 'vitest'
import { provider, providerForSkills } from '../src/role-skills.js'

describe('dsh-trading-role-skills provider', () => {
  it('bundles company-analysis and dynamic-capabilities with readable bodies', async () => {
    const candidates = await provider.list()
    expect(candidates.map(c => c.name)).toEqual(['company-analysis', 'dynamic-capabilities'])
    for (const candidate of candidates) {
      const skill = await provider.get(candidate)
      expect(skill.name).toBe(candidate.name)
      expect(skill.provider).toBe('dsh-trading-role-skills')
      expect(skill.source).toBe('bundled')
      expect(skill.content.length).toBeGreaterThan(100)
    }
    const company = await provider.get({ name: 'company-analysis' })
    expect(company.content).toContain('company-analysis')
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
})
