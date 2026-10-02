/**
 * 推送载荷契约测试（P4 步骤 4 的契约面）：纯函数，无 mock 无 sleep。
 */
import { describe, expect, it } from 'vitest'
import { DEEPLINK_SCHEME, PUSH_ACTIONS, PUSH_KINDS, PUSH_LIMITS, PUSH_SEVERITIES, shouldInterrupt, validatePushPayload, type PushPayload } from '../src/push.ts'

function payload(over: Partial<PushPayload> = {}): PushPayload {
  return {
    kind: 'escalation',
    severity: 'warning',
    deskId: 'desk-1',
    deeplink: DEEPLINK_SCHEME + 'escalations/esc-1',
    expiresInMs: 60_000,
    actions: ['approve', 'reject'],
    fallbackText: '有一条升级需要你确认',
    revision: 1,
    ...over,
  }
}

describe('推送载荷', () => {
  it('管理员：合法载荷通过，且三类枚举与动作集合都是封闭的', () => {
    // Given 一条正常通知
    // When 校验
    // Then 通过，且枚举是封闭集合
    expect(validatePushPayload(payload()).valid).toBe(true)
    expect(PUSH_SEVERITIES).toEqual(['info', 'warning', 'critical'])
    expect(PUSH_KINDS).toHaveLength(5)
    expect(PUSH_ACTIONS).toEqual(['ack', 'approve', 'reject', 'pause', 'kill'])
  })

  it('管理员：未知 kind / severity / action 一律不合法（通知的可用动作必须可校验）', () => {
    // Given 三种越界取值
    const badKind = validatePushPayload(payload({ kind: 'teleport' as never }))
    const badSeverity = validatePushPayload(payload({ severity: 'apocalyptic' as never }))
    const badAction = validatePushPayload(payload({ actions: ['launch-missiles' as never] }))
    // When 校验
    // Then 全部不合法且原因点名
    expect(badKind.valid).toBe(false)
    expect(badSeverity.valid).toBe(false)
    expect(badAction.problems.join(' ')).toContain('未知 action')
  })

  it('管理员：深链只允许应用内前缀（推送通道不得把用户送去任意站点）', () => {
    // Given 一条 http 深链
    const external = validatePushPayload(payload({ deeplink: 'https://evil.example/steal' }))
    // When 校验
    // Then 拒绝并说明原因
    expect(external.valid).toBe(false)
    expect(external.problems.join(' ')).toContain('deeplink 必须以')
  })

  it('管理员：critical 通知必须至少给一个可用动作（只喊危险不给出口不算合格）', () => {
    // Given 一条没有任何动作的 critical 通知
    const noExit = validatePushPayload(payload({ severity: 'critical', actions: [] }))
    // When 校验
    // Then 拒绝
    expect(noExit.valid).toBe(false)
    expect(noExit.problems.join(' ')).toContain('critical 通知必须至少有一个可用动作')
  })

  it('管理员：倒计时必须是正的有限数且有上限（只表达时限，不表达自动动作）', () => {
    // Given 三种非法倒计时
    // When 校验
    // Then 全部拒绝
    for (const bad of [0, -1, Number.NaN, PUSH_LIMITS.maxExpiresInMs + 1]) {
      expect(validatePushPayload(payload({ expiresInMs: bad })).valid, String(bad)).toBe(false)
    }
  })

  it('管理员：fallbackText 必填、动作数有上限、revision 必须非负有限', () => {
    // Given 四种越界
    // When 校验
    // Then 全部拒绝
    expect(validatePushPayload(payload({ fallbackText: '  ' })).valid).toBe(false)
    expect(validatePushPayload(payload({ actions: ['ack', 'approve', 'reject', 'pause'] })).valid).toBe(false)
    expect(validatePushPayload(payload({ revision: -1 })).valid).toBe(false)
    expect(validatePushPayload(payload({ deskId: '' })).valid).toBe(false)
  })

  it('管理员：静音只挡非 critical（critical 永远叫醒，静音不是关闭风险的开关）', () => {
    // Given 一条 info 与一条 critical，desk 都被静音
    const info = payload({ severity: 'info' })
    const critical = payload({ severity: 'critical' })
    // When 判断是否打断用户
    // Then info 不打断、critical 打断
    expect(shouldInterrupt(info, ['desk-1'])).toBe(false)
    expect(shouldInterrupt(critical, ['desk-1'])).toBe(true)
    expect(shouldInterrupt(info, [])).toBe(true)
  })

  it('管理员：UTF-16 码元边界（组合字符、代理对）超限即非法', () => {
    // Given 包含超长组合字符与代理对的推送载荷
    const combiningDeskOver = payload({ deskId: 'e\u0301'.repeat(33) })
    const combiningFallbackOver = payload({ fallbackText: 'e\u0301'.repeat(91) })
    const combiningLinkOver = payload({ deeplink: DEEPLINK_SCHEME + 'positions/' + 'e\u0301'.repeat(128) })
    const surrogateDeskOver = payload({ deskId: '\uD835\uDC00'.repeat(33) })
    const surrogateFallbackOver = payload({ fallbackText: '\uD835\uDC00'.repeat(91) })
    const surrogateLinkOver = payload({ deeplink: DEEPLINK_SCHEME + 'positions/' + '\uD835\uDC00'.repeat(128) })
    // When 校验载荷
    // Then 凡 UTF-16 码元超限者一律判非法
    expect(validatePushPayload(combiningDeskOver).valid).toBe(false)
    expect(validatePushPayload(combiningFallbackOver).valid).toBe(false)
    expect(validatePushPayload(combiningLinkOver).valid).toBe(false)
    expect(validatePushPayload(surrogateDeskOver).valid).toBe(false)
    expect(validatePushPayload(surrogateFallbackOver).valid).toBe(false)
    expect(validatePushPayload(surrogateLinkOver).valid).toBe(false)
  })

  it('管理员：数值域边界（有限小数 expiresInMs 与 revision）合法，NaN/非正/负数被拒', () => {
    // Given 有限小数与非有限数值的推送载荷
    const validFractional = payload({ expiresInMs: 1500.5, revision: 3.5 })
    const zeroRev = payload({ revision: 0 })
    const infExpires = payload({ expiresInMs: Number.POSITIVE_INFINITY })
    const infRev = payload({ revision: Number.POSITIVE_INFINITY })
    // When 校验载荷
    // Then 有限小数与零合法，非有限数非法
    expect(validatePushPayload(validFractional).valid).toBe(true)
    expect(validatePushPayload(zeroRev).valid).toBe(true)
    expect(validatePushPayload(infExpires).valid).toBe(false)
    expect(validatePushPayload(infRev).valid).toBe(false)
  })

  it('管理员：代理对与组合字符恰在上限边界时合法', () => {
    // Given 恰在 64/180 码元上限边界的代理对与组合字符推送
    const exactSurrogate = payload({
      deskId: '\uD835\uDC00'.repeat(32),
      fallbackText: '\uD835\uDC00'.repeat(90),
    })
    const exactCombining = payload({
      deskId: 'e\u0301'.repeat(32),
      fallbackText: 'e\u0301'.repeat(90),
    })
    // When 校验载荷
    // Then 均判合法
    expect(validatePushPayload(exactSurrogate).valid).toBe(true)
    expect(validatePushPayload(exactCombining).valid).toBe(true)
  })
})
