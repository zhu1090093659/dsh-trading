/**
 * 客户端会话协商的测试（App 的第一个真测试）。
 *
 * 判据不在 App 里：状态码、能力头、降级语义都由 @dshtrading/contract 定义，
 * 这里只验"App 用对了契约"—— 不重复实现、也不放宽契约。
 *
 * 语义备忘（读 version.ts 得到，第一版测试曾猜错）：
 *   - requiredCaps 检查的是**客户端是否具备**该能力，缺了即 426（与"服务端是否提供"无关）；
 *   - serverCaps 只用来算 usable / downgraded —— 服务端没声明能力时两者都为空，仍算通过。
 */
import { describe, expect, it } from 'vitest'
import { CLIENT_TOO_OLD_STATUS } from '@dshtrading/contract/core'
import { CLIENT_CAPS, describeHandshake, handshake, isClientTooOld } from '../src/session.ts'

describe('客户端版本与能力协商', () => {
  it('管理员：服务端声明了客户端的能力时协商通过，且无降级', () => {
    // Given 服务端声明了客户端全部能力
    const headers = { 'x-dsht-caps': CLIENT_CAPS.join(',') }
    // When 用真实响应头协商，且本次响应要求客户端具备 cards.v1
    const verdict = handshake({ headers, requiredCaps: ['cards.v1'] })
    // Then 通过、无降级、可渲染
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.downgraded).toEqual([])
      expect([...verdict.caps].sort()).toEqual([...CLIENT_CAPS].sort())
      expect(describeHandshake(verdict)).toContain('契约可用')
    }
  })

  it('管理员：客户端缺少本次响应必需的能力时判为过旧（HTTP 426）', () => {
    // Given 客户端不具备的能力被本次响应要求（trade.confirm 不在 CLIENT_CAPS 里）
    // When 协商
    const verdict = handshake({ headers: { 'x-dsht-caps': 'trade.confirm' }, requiredCaps: ['trade.confirm'] })
    // Then 不通过、状态码取自契约常量、可渲染为"不兼容"
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.status).toBe(CLIENT_TOO_OLD_STATUS)
      expect(verdict.code).toBe('CLIENT_TOO_OLD')
      expect(describeHandshake(verdict)).toContain('不兼容')
    }
    expect(isClientTooOld(verdict)).toBe(true)
  })

  it('管理员：服务端未声明能力时不抛错（按"无能力"处理，客户端自备的仍算通过）', () => {
    // Given 没有任何 caps 头
    // When 协商一个客户端确实具备的能力
    const verdict = handshake({ headers: {}, requiredCaps: ['cards.v1'] })
    // Then 通过，且 caps 与 downgraded 都为空（服务端没声明就没得降级）
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.caps).toEqual([])
      expect(verdict.downgraded).toEqual([])
    }
  })

  it('管理员：服务端多声明了客户端没有的能力时，记入降级而不是失败', () => {
    // Given 服务端多声明了一个客户端没有的能力
    const headers = { 'x-dsht-caps': 'cards.v1,server.only.cap' }
    // When 协商
    const verdict = handshake({ headers, requiredCaps: ['cards.v1'] })
    // Then 仍通过，降级项如实列出（不静默丢弃）
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.downgraded).toEqual(['server.only.cap'])
      expect(verdict.caps).toEqual(['cards.v1'])
    }
  })
})
