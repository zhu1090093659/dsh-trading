/**
 * 作者字段归一（authors.ts）不变量：别名表的值本身必须是规范名（无链式映射），
 * 归一是幂等的，历史脏数据在读取层不抛错。
 */
import { describe, expect, it } from 'vitest'
import { AUTHOR_ALIASES, canonicalAuthor, canonicalizeCardAuthor } from '../src/authors.ts'
import type { KnowledgeCard } from '../src/types.ts'

function createCardWithAuthor(author: string): KnowledgeCard {
  return {
    id: 'kc_author_probe',
    title: '作者归一探针卡',
    summary: '用于验证作者字段归一的探针卡片。',
    source: { type: 'bilibili', url: 'https://www.bilibili.com/video/BVAuthorProbe', author },
    credibility: 'medium',
    coreClaims: ['探针论点'],
    factCheck: { verified: [], discrepancies: [], unverifiable: [] },
    takeaways: [],
    boundaries: [],
    tags: ['其他/评论'],
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  }
}

describe('作者字段归一（cross-platform author canonicalization）', () => {
  it('运营登记新别名时每条别名都归一为表中的规范名', () => {
    // Given: 别名表里的每条「历史写法 -> 规范名」
    const aliases = Object.entries(AUTHOR_ALIASES)
    // When: 逐条归一
    const canonical = aliases.map(([alias]) => canonicalAuthor(alias))
    // Then: 归一结果等于表中规范名且非空
    expect(aliases.length).toBeGreaterThan(0)
    for (const [alias, expected] of aliases) {
      expect(canonicalAuthor(alias), alias).toBe(expected)
      expect(expected.length, alias).toBeGreaterThan(0)
    }
    expect(canonical).toHaveLength(aliases.length)
  })

  it('运营维护别名表时规范名本身是定式点（不得再被映射）', () => {
    // Given: 别名表的值（规范名）
    const canonicalNames = Object.values(AUTHOR_ALIASES)
    // When: 对规范名再做一次归一
    // Then: 值不再变化，且不作为键出现——归一结果不依赖表内顺序或链式跳转
    for (const canonical of canonicalNames) {
      expect(canonicalAuthor(canonical), canonical).toBe(canonical)
      expect(AUTHOR_ALIASES[canonical], canonical).toBeUndefined()
    }
    expect(new Set(canonicalNames).size).toBeGreaterThan(0)
  })

  it('运营维护别名表时不存在匹配不到的死条目', () => {
    // Given: 别名表的每条键值对（查找键先 trim，值不得等于键）
    const entries = Object.entries(AUTHOR_ALIASES)
    // When: 逐条检查键是否可能命中、值是否真的改写
    // Then: 键无首尾空白（否则 trim 后永不命中），且键值不同（自映射等于没归一）
    for (const [alias, canonical] of entries) {
      expect(alias, alias).toBe(alias.trim())
      expect(alias, alias).not.toBe(canonical)
      expect(canonical, alias).toBe(canonical.trim())
    }
    expect(entries).toHaveLength(new Set(entries.map(([alias]) => alias)).size)
  })

  it('用户提交未登记的作者名时原样保留并去除首尾空白', () => {
    // Given: 未登记的写法与带空白的历史写法
    const unknown = '艾丽的无废话财经'
    const padded = '  火星船长1989  '
    // When: 归一
    const results = [canonicalAuthor(unknown), canonicalAuthor(padded), canonicalAuthor('')]
    // Then: 未登记名不动，仅去首尾空白；空作者仍为空
    expect(results).toEqual(['艾丽的无废话财经', '火星船长1989', ''])
  })

  it('用户提交同一主体在不同平台的历史写法时收敛为同一个规范名', () => {
    // Given: 同一主体（B站 UP「鳄鱼派」+ 公众号「像鳄鱼一样思考」）的三种历史写法
    const variants = ['鳄鱼派', '鳄鱼派（公众号：像鳄鱼一样思考）', '像鳄鱼一样思考（鳄鱼派）']
    // When: 归一
    const canonical = variants.map(canonicalAuthor)
    // Then: 三种写法收敛到一行（GUI 作者下拉与 co-author 边不再分裂）
    expect(new Set(canonical).size).toBe(1)
    expect(canonical[0]).toBe('鳄鱼派（像鳄鱼一样思考）')
  })

  it('用户读取历史卡片时作者被归一且传入卡片不被改写', () => {
    // Given: 一张 author 为历史写法的卡片，以及一张已是规范名的卡片
    const legacy = createCardWithAuthor('鳄鱼派（公众号：像鳄鱼一样思考）')
    const legacySnapshot = JSON.stringify(legacy)
    const alreadyCanonical = createCardWithAuthor('艾丽的无废话财经')
    // When: 分别归一
    const healed = canonicalizeCardAuthor(legacy)
    const untouched = canonicalizeCardAuthor(alreadyCanonical)
    // Then: 副本为规范名、入参零改动、已是规范名的卡片原引用返回
    expect(healed.source.author).toBe('鳄鱼派（像鳄鱼一样思考）')
    expect(JSON.stringify(legacy)).toBe(legacySnapshot)
    expect(untouched).toBe(alreadyCanonical)
  })

  it('用户读取缺少 source 或 author 非字符串的历史脏条目时不被抛错', () => {
    // Given: 三条文件层历史脏数据（缺 source、author 非字符串、author 全空白）
    const missingSource = { id: 'kc_broken_row', title: '畸形容器行' } as unknown as KnowledgeCard
    const numericAuthor = createCardWithAuthor(123 as unknown as string)
    const whitespaceAuthor = createCardWithAuthor('   ')
    // When: 逐条归一
    const results = [
      canonicalizeCardAuthor(missingSource),
      canonicalizeCardAuthor(numericAuthor),
      canonicalizeCardAuthor(whitespaceAuthor),
    ]
    // Then: 前两条原样放行不抛错；空白作者归一为空串（GUI 侧按空值跳过，不入作者下拉）
    expect(results[0]).toBe(missingSource)
    expect(results[1]).toBe(numericAuthor)
    expect(results[2].source.author).toBe('')
  })
})
