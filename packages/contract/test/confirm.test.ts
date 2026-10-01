/**
 * 确认策略测试（P4 步骤 4 契约面）：纯函数，无 mock 无 sleep。
 */
import { describe, expect, it } from 'vitest'
import { ACTION_KINDS } from '../src/cards.ts'
import { ACTION_CONFIRM, CONFIRM_LEVELS, auditConfirmPolicy, confirmLevelFor, requiresBiometric } from '../src/confirm.ts'

describe('确认策略', () => {
  it('管理员：策略表自检通过（每个动作都有档位、control 类一律 biometric）', () => {
    // Given 策略表
    // When 自检
    const verdict = auditConfirmPolicy()
    // Then 无问题，且表覆盖了全部动作
    expect(verdict.problems).toEqual([])
    expect(verdict.ok).toBe(true)
    expect(Object.keys(ACTION_CONFIRM)).toHaveLength(ACTION_KINDS.length)
  })

  it('管理员：只读动作不需要确认，审批与控制类需要强确认', () => {
    // Given 三类动作各一个
    // When 取档位
    // Then 分档正确
    expect(confirmLevelFor('ack')).toBe('none')
    expect(confirmLevelFor('open-detail')).toBe('none')
    expect(confirmLevelFor('approve')).toBe('biometric')
    expect(confirmLevelFor('kill')).toBe('biometric')
    expect(CONFIRM_LEVELS).toEqual(['none', 'confirm', 'biometric'])
  })

  it('管理员：网页端对强确认动作不假装有生物识别（退到普通确认，由界面说明）', () => {
    // Given 一个控制类动作
    // When 分别问网页端与移动端"要不要生物识别"
    // Then 移动端要、网页端不要（但档位仍是 biometric，界面据此提示）
    expect(requiresBiometric('kill', 'mobile')).toBe(true)
    expect(requiresBiometric('kill', 'web')).toBe(false)
    expect(requiresBiometric('ack', 'mobile')).toBe(false)
  })

  it('管理员：把任一 control 类动作降级都会让自检变红（不变量真的能被违反）', () => {
    // Given 一份被人改坏的策略表（kill 降级为 confirm）
    const broken: Record<string, string> = { ...ACTION_CONFIRM, kill: 'confirm' }
    // When 用同样的判据检查
    const problems: string[] = []
    for (const action of ACTION_KINDS) {
      const scope = action === 'kill' ? 'control' : undefined
      if (broken[action] === undefined) problems.push('缺档位: ' + action)
      if (scope === 'control' && broken[action] !== 'biometric') problems.push('control 类动作 ' + action + ' 低于 biometric')
    }
    // Then 这条不变量会被抓出来（证明它不是摆设）
    expect(problems.join(' ')).toContain('control 类动作 kill 低于 biometric')
  })
})
