/**
 * 离线横幅测试：陈旧度边界由契约定义，这里验 App 的翻译与边界处理。
 */
import { describe, expect, it } from 'vitest'
import { offlineBanner } from '../src/offline.ts'

const NOW = 1_700_000_000_000
const BUDGETS = { freshMs: 5_000, staleMs: 30_000, ttlMs: 300_000 }
const snapshotAt = (agoMs: number) => ({ atMs: NOW - agoMs, data: ['row'] as readonly string[], sourceId: 'bot' })

describe('离线横幅', () => {
  it('管理员：没有快照时给"还没有本地数据"的提示（不是空白）', () => {
    // Given 没有本地快照
    // When 取横幅
    const banner = offlineBanner(undefined, NOW, BUDGETS)
    // Then 是提示型，且文案来自契约
    expect(banner.kind).toBe('notice')
    expect(banner.staleness).toBe('unknown')
    expect(banner.hint).toContain('还没有本地数据')
  })

  it('管理员：新鲜数据可显示且无多余提示', () => {
    // Given 1 秒前的快照
    const banner = offlineBanner(snapshotAt(1_000), NOW, BUDGETS)
    // Then 可显示、判 fresh、无提示
    expect(banner.kind).toBe('data')
    expect(banner.staleness).toBe('fresh')
    expect(banner.hint).toBe('')
  })

  it('管理员：aging / stale 分别给出不同提示（提示随陈旧度变化）', () => {
    // Given 10 秒前与 60 秒前的快照
    const aging = offlineBanner(snapshotAt(10_000), NOW, BUDGETS)
    const stale = offlineBanner(snapshotAt(60_000), NOW, BUDGETS)
    // Then 两者都可显示，但提示不同、且都提示了"旧"
    expect(aging.kind).toBe('data')
    expect(stale.kind).toBe('data')
    expect(aging.hint).toContain('略旧')
    expect(stale.hint).toContain('较旧')
    expect(aging.hint).not.toBe(stale.hint)
  })

  it('管理员：超过 ttl 的数据不显示，只给过期提示（过期数据永不渲染）', () => {
    // Given 10 分钟前的快照（ttl 5 分钟）
    const banner = offlineBanner(snapshotAt(600_000), NOW, BUDGETS)
    // Then 是提示型、判 expired、且**不返回任何数据**
    expect(banner.kind).toBe('notice')
    expect(banner.staleness).toBe('expired')
    expect(banner.hint).toContain('过期')
    expect(Object.keys(banner)).not.toContain('view')
  })

  it('管理员：预算顺序不合法时判 unknown（不假装数据可信）', () => {
    // Given fresh > stale 的乱序预算
    const banner = offlineBanner(snapshotAt(1_000), NOW, { freshMs: 30_000, staleMs: 5_000, ttlMs: 300_000 })
    // Then 判 unknown（契约的防御），并给出提示
    expect(banner.staleness).toBe('unknown')
    expect(banner.kind).toBe('notice')
  })
})
