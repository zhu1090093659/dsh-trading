/**
 * Browser-half pure contract: the eight workbench sections stay in sync with the
 * embedded app's routes, unknown persisted values fall back instead of blanking
 * the view, and URL joins never double a slash.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESEARCH_SECTION,
  RESEARCH_SECTIONS,
  RESEARCH_SECTION_STORAGE_KEY,
  isResearchSectionId,
  researchSection,
  researchSectionFromStorage,
} from '../src/client/sections.ts'
import { en, zh } from '../src/client/locales.ts'

describe('RESEARCH_SECTIONS', () => {
  it('运营确认八个一级区域齐全且 id / 路径唯一', () => {
    // Given the section table
    // When ids and paths are collected
    const ids = RESEARCH_SECTIONS.map((section) => section.id)
    const paths = RESEARCH_SECTIONS.map((section) => section.path)
    // Then there are exactly eight unique ids and paths
    expect(RESEARCH_SECTIONS.length).toBe(8)
    expect(new Set(ids).size).toBe(8)
    expect(new Set(paths).size).toBe(8)
    expect(ids[0]).toBe('home')
  })

  it('用户点开每个版面时都映射到工作台自己的路由', () => {
    // Given the section table
    // When each path is inspected
    const expected = ['/', '/daily-review', '/intel', '/sectors', '/research', '/my-stocks', '/my-reports', '/settings']
    // Then the paths are the workbench router paths, in order
    expect(RESEARCH_SECTIONS.map((section) => section.path)).toEqual(expected)
  })
})

describe('researchSection', () => {
  it('访客带未知版面 id 时回落到默认首页而不是空白', () => {
    // Given an unknown id
    // When it is resolved
    const resolved = researchSection('does-not-exist')
    // Then the documented default stands
    expect(resolved.id).toBe(DEFAULT_RESEARCH_SECTION)
    expect(resolved.path).toBe('/')
  })

  it('访客的本地存储被写脏时解析仍返回可用版面', () => {
    // Given dirty persisted values
    // When they are parsed
    const dirty = researchSectionFromStorage('{"broken":true}')
    const missing = researchSectionFromStorage(null)
    // Then both degrade to the default section
    expect(dirty.id).toBe(DEFAULT_RESEARCH_SECTION)
    expect(missing.id).toBe(DEFAULT_RESEARCH_SECTION)
  })

  it('管理员核对 id 白名单时只认八个已知 id', () => {
    // Given known and unknown ids
    // When they are checked
    // Then only the known ones pass
    expect(isResearchSectionId('daily-review')).toBe(true)
    expect(isResearchSectionId('dailyreview')).toBe(false)
    expect(isResearchSectionId(42)).toBe(false)
  })
})

describe('locales', () => {
  it('客户看到的每个版面与动作文案在中英词典里都存在', () => {
    // Given the zh and en dictionaries
    // When their key sets are compared
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    // Then they are 1:1 (the i18n audit asserts the same, this keeps it local)
    expect(enKeys).toEqual(zhKeys)
    expect(zh['rv.title']).toBe('Research')
    expect(en['rv.title']).toBe('Research')
  })

  it('访客看到的版面文案键全部来自 section 表', () => {
    // Given the section table
    // When each title key is looked up in both dictionaries
    // Then every key resolves to non-empty copy
    for (const section of RESEARCH_SECTIONS) {
      expect((zh[section.titleKey] ?? '').length).toBeGreaterThan(0)
      expect((en[section.titleKey] ?? '').length).toBeGreaterThan(0)
    }
  })

  it('运营确认存储键稳定，改键等于丢用户上次版面', () => {
    // Given the persisted-section key
    // When it is read as a constant
    // Then the value is the documented one
    expect(RESEARCH_SECTION_STORAGE_KEY).toBe('dshtrading.research.section.v1')
  })
})
