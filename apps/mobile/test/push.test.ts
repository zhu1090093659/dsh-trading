/**
 * 推送处理测试：判据来自契约，这里验合成决定与两条 fail closed。
 */
import { describe, expect, it } from 'vitest'
import type { PushPayload } from '@dshtrading/contract/core'
import { handlePush } from '../src/push.ts'

/** 造一条合法载荷（字段按契约要求）。 */
function payload(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    kind: 'escalation',
    severity: 'warning',
    deskId: 'desk-1',
    deeplink: 'dshtrading://decisions',
    expiresInMs: 60_000,
    actions: [],
    fallbackText: 'dsh-trading 有一条通知',
    revision: 7,
    ...overrides,
  } as PushPayload
}

describe('推送处理', () => {
  it('管理员：合法载荷打开深链指定的屏幕，并按严重度决定是否打断', () => {
    // Given 一条 warning 级、指向 decisions 的载荷，用户没静音
    // When 处理
    const decision = handlePush(payload(), { muted: [] })
    // Then 打开 decisions 且打断
    expect(decision.kind).toBe('open')
    if (decision.kind === 'open') {
      expect(decision.screen).toBe('decisions')
      expect(decision.interrupt).toBe(true)
      expect(decision.critical).toBe(false)
      expect(decision.revision).toBe(7)
    }
  })

  it('管理员：critical 即使被静音也打断（静音挡不住 critical）', () => {
    // Given critical 级载荷，且该 desk 已被静音
    // When 处理
    const decision = handlePush(payload({ severity: 'critical', actions: ['ack'] }), { muted: ['desk-1'] })
    // Then 仍打断
    expect(decision.kind).toBe('open')
    if (decision.kind === 'open') {
      expect(decision.critical).toBe(true)
      expect(decision.interrupt).toBe(true)
    }
  })

  it('管理员：非 critical 且静音时不打断（但仍会打开）', () => {
    // Given warning 级载荷 + 该 desk 静音
    // When 处理
    const decision = handlePush(payload(), { muted: ['desk-1'] })
    // Then 打开但不打断
    expect(decision.kind).toBe('open')
    if (decision.kind === 'open') expect(decision.interrupt).toBe(false)
  })

  it('管理员：非法载荷被丢弃且理由来自契约校验', () => {
    // Given 未知 kind 的载荷
    // When 处理
    const decision = handlePush(payload({ kind: 'not-a-kind' as never }), { muted: [] })
    // Then 丢弃，理由是校验问题
    expect(decision.kind).toBe('drop')
    if (decision.kind === 'drop') expect(decision.reason).toContain('载荷非法')
  })

  it('管理员：外部链接深链一律不打开（开放集之外）', () => {
    // Given 指向外部站点的 deeplink
    // When 处理
    const decision = handlePush(payload({ deeplink: 'https://evil.example.com/x' }), { muted: [] })
    // Then 丢弃（契约的校验就已挡住）
    expect(decision.kind).toBe('drop')
  })
})
