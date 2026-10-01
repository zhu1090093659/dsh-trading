/**
 * 动作确认闸门测试：档位表是契约的，这里验 App 的翻译与 fail closed。
 */
import { describe, expect, it } from 'vitest'
import { ACTION_KINDS, ACTION_SCOPE, auditConfirmPolicy, type ActionKind } from '@dshtrading/contract/core'
import { gateForAction } from '../src/confirm.ts'

/** 从契约的动作表里取一个指定作用域的动作，避免在测试里写死动作名。 */
function actionWithScope(scope: 'read' | 'command' | 'control'): ActionKind {
  const found = ACTION_KINDS.find((action) => ACTION_SCOPE[action] === scope)
  if (found === undefined) throw new Error('契约里没有 ' + scope + ' 类动作')
  return found
}

describe('动作确认闸门', () => {
  it('管理员：control 类动作在移动端必须走生物识别', () => {
    // Given 一个 control 类动作
    const action = actionWithScope('control')
    // When 问闸门
    const decision = gateForAction(action, 'mobile')
    // Then 必须生物识别
    expect(decision.kind).toBe('biometric')
  })

  it('管理员：网页端没有生物识别时降为二次确认（不假装有）', () => {
    // Given 同一个 control 类动作
    const action = actionWithScope('control')
    // When 在 web 平台问闸门
    const decision = gateForAction(action, 'web')
    // Then 降为 confirm，且提示说明了原因
    expect(decision.kind).toBe('confirm')
    if (decision.kind === 'confirm') expect(decision.prompt).toContain('移动端')
  })

  it('管理员：未知动作 fail closed（按最高档处理，绝不静默放行）', () => {
    // Given 一个契约表里没有的动作
    // When 问闸门
    const decision = gateForAction('definitely.not.an.action' as never, 'mobile')
    // Then 是生物识别，且理由是 UNKNOWN_ACTION
    expect(decision.kind).toBe('biometric')
    if (decision.kind === 'biometric') expect(decision.reason).toBe('UNKNOWN_ACTION')
  })

  it('管理员：契约的确认策略表本身通过自检（control 一律 biometric）', () => {
    // Given 契约的策略表
    // When 跑它的机检
    const audit = auditConfirmPolicy()
    // Then 无问题
    expect(audit.ok).toBe(true)
    expect(audit.problems).toEqual([])
  })
})
