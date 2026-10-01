/**
 * 数据源守卫契约测试（P4 步骤 5 要求的证据之一：
 * 「同 id 不同 sourceId 只显示当前源」+ 切换期只读 + 对账）。
 */
import { describe, expect, it } from 'vitest'
import { createSourceGuard, type SourcedDatum } from '../src/source-guard.ts'

const local = (id: string, value: string): SourcedDatum<string> => ({ id, sourceId: 'local', value })
const remote = (id: string, value: string): SourcedDatum<string> => ({ id, sourceId: 'bot', value })

describe('数据源守卫', () => {
  it('管理员：同 id 出现在两个源时，视图里只有当前源那一条（跨源永不混显）', () => {
    // Given 两个源里各有一条同名 id（值不同）
    const guard = createSourceGuard<string>({ activeSourceId: 'local' })
    const data = [local('desk-1', '本地 desk'), remote('desk-1', '远端 desk')]
    // When 取视图
    const view = guard.viewOf(data)
    // Then 只有本地那条
    expect(view).toHaveLength(1)
    expect(view[0]?.value).toBe('本地 desk')
  })

  it('管理员：切换期是只读的，对账通过后才恢复可写并换源', () => {
    // Given 一个本地源守卫
    const guard = createSourceGuard<string>({ activeSourceId: 'local' })
    expect(guard.writable()).toBe(true)
    // When 切到远端
    guard.switchTo('bot')
    // Then 立刻进入只读（不靠调用方自觉）
    expect(guard.writable()).toBe(false)
    expect(guard.switching()).toBe(true)
    // When 对账通过
    const report = guard.reconcile([local('desk-1', 'a')], [remote('desk-1', 'b')])
    // Then 换源且恢复可写，视图随之切换到远端
    expect(report.ok).toBe(true)
    expect(guard.sourceId()).toBe('bot')
    expect(guard.writable()).toBe(true)
    expect(guard.viewOf([local('desk-1', 'a'), remote('desk-1', 'b')])[0]?.value).toBe('b')
  })

  it('管理员：对账条数不一致时保持只读且不换源（不许把半个源显示出来）', () => {
    // Given 已开始切换到远端
    const guard = createSourceGuard<string>({ activeSourceId: 'local' })
    guard.switchTo('bot')
    // When 对账时条数不符
    const report = guard.reconcile([local('a', '1'), local('b', '2')], [remote('a', '1')])
    // Then 明确失败、给出原因、仍然只读、源没换
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('条数不一致')
    expect(guard.writable()).toBe(false)
    expect(guard.sourceId()).toBe('local')
  })

  it('管理员：切到同一个源不算切换（刷新不该把界面变成只读）', () => {
    // Given 当前是本地源
    const guard = createSourceGuard<string>({ activeSourceId: 'local' })
    // When 对同一个源调用 switchTo
    guard.switchTo('local')
    // Then 没有进入切换态
    expect(guard.switching()).toBe(false)
    expect(guard.writable()).toBe(true)
  })
})
