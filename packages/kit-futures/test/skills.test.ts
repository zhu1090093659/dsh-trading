/**
 * kit-futures skill provider：名册、按名分发与白名单收窄
 * （与 kit-hk/test 同口径；共享技能目录与 base role-skill 白名单必须对齐，
 * 少提供一项会在 apply 期 fail-fast，见 packages/base/src/presets.ts KIT_SKILLS）。
 */
import { describe, expect, it } from 'vitest'
import { provider, providerForSkills } from '../src/index.ts'

const EXPECTED = [
  'futures-risk-checklist',
  'indicator-authoring',
  'trading-strategy-paradigms',
  'knowledge-curation',
  'trading-notes-setup',
]

describe('kit-futures skill provider', () => {
  it('list 返回全部候选，名字唯一', async () => {
    const list = await provider.list()
    expect(list.map((c) => c.name)).toEqual(EXPECTED)
  })

  it('get 按名分发：各个 skill 的 content 都真实可读', async () => {
    for (const name of EXPECTED) {
      const skill = await provider.get({ name, provider: 'dsh-trading-futures' } as never)
      expect(skill.name).toBe(name)
      expect(skill.content.length).toBeGreaterThan(100)
    }
  })

  it('get 未知名字回落 risk-checklist（防御）', async () => {
    const skill = await provider.get({ name: 'nonexistent' } as never)
    expect(skill.name).toBe('futures-risk-checklist')
  })

  it('providerForSkills 按白名单收窄：空名单不暴露、名单外 get 拒绝、未知名 fail-fast、缺省全量', async () => {
    const scoped = providerForSkills(['futures-risk-checklist', 'trading-notes-setup'])
    expect((await scoped.list()).map((c) => c.name)).toEqual(['futures-risk-checklist', 'trading-notes-setup'])
    expect((await scoped.get({ name: 'trading-notes-setup' } as never)).name).toBe('trading-notes-setup')
    const empty = providerForSkills([])
    expect(await empty.list()).toEqual([])
    await expect(empty.get({ name: 'futures-risk-checklist' } as never)).rejects.toThrow('not in whitelist')
    expect(() => providerForSkills(['no-such-skill'])).toThrow('unknown skills in whitelist')
    expect(providerForSkills()).toBe(provider)
  })

  it('base role-skill 白名单可完整解析（trader / instrument-researcher / risk-reviewer 三套）', async () => {
    for (const whitelist of [
      ['futures-risk-checklist', 'trading-strategy-paradigms', 'indicator-authoring', 'trading-notes-setup'],
      ['knowledge-curation', 'trading-notes-setup'],
      ['futures-risk-checklist', 'trading-notes-setup'],
    ]) {
      expect(() => providerForSkills(whitelist)).not.toThrow()
      const listed = (await providerForSkills(whitelist).list()).map((c) => c.name)
      expect(listed).toHaveLength(whitelist.length)
      expect([...listed].sort()).toEqual([...whitelist].sort())
    }
  })
})
