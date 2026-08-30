/**
 * kit-crypto skill provider：双 skill 名册与按名分发（WS3，docs/analysis-roadmap.md #5）。
 */
import { describe, expect, it } from 'vitest'
import { provider } from '../src/index.ts'

describe('kit-crypto skill provider', () => {
  it('list 返回两个候选（risk-checklist + instrument-analysis），名字唯一', async () => {
    const list = await provider.list()
    expect(list.map((c) => c.name)).toEqual(['crypto-risk-checklist', 'crypto-instrument-analysis'])
  })

  it('get 按名分发：两个 skill 的 content 都真实可读且含 name 行', async () => {
    for (const name of ['crypto-risk-checklist', 'crypto-instrument-analysis']) {
      const skill = await provider.get({ name, provider: 'dsh-trading-crypto' } as never)
      expect(skill.name).toBe(name)
      expect(skill.content).toContain('name: ' + name)
      expect(skill.content.length).toBeGreaterThan(500)
    }
  })

  it('get 未知名字回落 risk-checklist（防御）', async () => {
    const skill = await provider.get({ name: 'nonexistent' } as never)
    expect(skill.name).toBe('crypto-risk-checklist')
  })
})
