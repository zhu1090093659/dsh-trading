/**
 * 用户动作的确认闸门（App 侧）。
 *
 * **档位不在这里决定**：哪个动作要 confirm、哪个必须 biometric，都由 @dshtrading/contract
 * 的 ACTION_CONFIRM / confirmLevelFor / requiresBiometric 给出（表本身还有 CI 机检）。
 * 这里只负责两件事：
 *   1. 把档位翻成 UI 能直接用的决定（allow / confirm / biometric）；
 *   2. **对未知动作 fail closed** —— 契约返回 undefined 时按最高档处理，
 *      绝不因为"表里没写"就放行（本会话已确立的不变量：未知关闭枚举让卡片不可操作，但永不静默放行）。
 */
import { confirmLevelFor, requiresBiometric, type ActionKind } from '@dshtrading/contract/core'

export type Platform = 'mobile' | 'web'

export type GateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'confirm'; readonly prompt: string }
  | { readonly kind: 'biometric'; readonly prompt: string; readonly reason: string }

/**
 * 为某个动作决定确认方式。
 * @param action - 动作种类（契约的 ActionKind）。
 * @param platform - 运行平台；网页端没有生物识别。
 */
export function gateForAction(action: ActionKind, platform: Platform): GateDecision {
  const level = confirmLevelFor(action)
  if (level === undefined || level === null) {
    // 未知动作：fail closed
    return { kind: 'biometric', prompt: '这个操作不在已知动作表里，已按最高档处理', reason: 'UNKNOWN_ACTION' }
  }
  if (level === 'none') return { kind: 'allow' }
  if (level === 'confirm') {
    return { kind: 'confirm', prompt: requiresBiometric(action, platform) ? '请再次确认' : '请确认这次操作' }
  }
  // biometric
  if (platform === 'web') {
    return {
      kind: 'confirm',
      prompt: '该操作在移动端需要生物识别；网页端只能二次确认',
    }
  }
  return { kind: 'biometric', prompt: '请通过生物识别确认', reason: 'CONTROL_ACTION' }
}
