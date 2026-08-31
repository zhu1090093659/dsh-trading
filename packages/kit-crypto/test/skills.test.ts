/**
 * kit-crypto skill provider：名册与按名分发。
 */
import { describe, expect, it } from 'vitest'
import { provider } from '../src/index.ts'

describe('kit-crypto skill provider', () => {
  it('list 返回全部候选（risk-checklist + instrument-analysis + indicator-authoring + trading-strategy-paradigms + knowledge-curation），名字唯一', async () => {
    const list = await provider.list()
    expect(list.map((c) => c.name)).toEqual([
      'crypto-risk-checklist',
      'crypto-instrument-analysis',
      'indicator-authoring',
      'trading-strategy-paradigms',
      'knowledge-curation',
    ])
  })

  it('get 按名分发：各个 skill 的 content 都真实可读', async () => {
    for (const name of [
      'crypto-risk-checklist',
      'crypto-instrument-analysis',
      'indicator-authoring',
      'trading-strategy-paradigms',
      'knowledge-curation',
    ]) {
      const skill = await provider.get({ name, provider: 'dsh-trading-crypto' } as never)
      expect(skill.name).toBe(name)
      expect(skill.content.length).toBeGreaterThan(100)
    }
  })

  it('get 未知名字回落 risk-checklist（防御）', async () => {
    const skill = await provider.get({ name: 'nonexistent' } as never)
    expect(skill.name).toBe('crypto-risk-checklist')
  })
})
