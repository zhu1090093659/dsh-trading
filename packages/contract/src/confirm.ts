/**
 * 确认策略（P4 步骤 4 的契约面）：**哪些动作必须经过人的强确认**。
 *
 * 网页与移动端的**确认机制不同**（网页 %%window.confirm%%，移动端生物识别），但"哪些动作
 * 需要强确认"这条**判据必须只有一个家** —— 否则会出现"网页拦住了、手机没拦"或者反过来，
 * 而这种不一致恰恰出现在最危险的动作上。
 *
 * 三档：
 *   - %%none%%：只读类动作（ack / dismiss / open-detail），点一下即可；
 *   - %%confirm%%：普通确认（够用即可，网页用弹窗、移动端可用普通对话框）；
 *   - %%biometric%%：**强确认** —— 控制类与审批类动作。移动端必须过生物识别，
 *     网页端没有生物识别可用时不低于 %%confirm%%（并在界面上显示"此动作在移动端需生物识别"）。
 *
 * 一条不许妥协的不变量：**control 平面上的任何动作都不得低于 %%biometric%%**。
 * 理由：kill/flatten 会让真实仓位动起来，把它们降级成"点一下就行"是事故的常见起点。
 *
 * @module @dshtrading/contract/confirm
 */
import { ACTION_KINDS, type ActionKind } from './cards.ts'
import { ACTION_SCOPE } from './cards.ts'

/** 确认档位。 */
export const CONFIRM_LEVELS = ['none', 'confirm', 'biometric'] as const
export type ConfirmLevel = (typeof CONFIRM_LEVELS)[number]

/** 每个动作的确认档位（**判据的唯一之家**）。 */
export const ACTION_CONFIRM: Record<ActionKind, ConfirmLevel> = {
  // 只读：点一下就行
  ack: 'none',
  dismiss: 'none',
  'open-detail': 'none',
  'retry-sync': 'none',
  // 审批：要人明确表态，但不必每次都验生物特征
  approve: 'biometric',
  reject: 'biometric',
  // 控制：一律强确认
  pause: 'biometric',
  resume: 'biometric',
  kill: 'biometric',
  flatten: 'biometric',
  'grant-control': 'biometric',
  'revoke-device': 'biometric',
}

/**
 * 取一个动作要求的确认档位。
 * @param action - 动作类型。
 */
export function confirmLevelFor(action: ActionKind): ConfirmLevel {
  return ACTION_CONFIRM[action]
}

/**
 * 校验确认策略表自身的完整性（**CI 可机检**）：每个动作都有档位，且 control 类动作
 * 一律 %%biometric%%。表的形状与 %%ACTION_KINDS%% 对不上时这条会红。
 */
export function auditConfirmPolicy(): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = []
  for (const action of ACTION_KINDS) {
    const level = ACTION_CONFIRM[action]
    if (level === undefined) {
      problems.push('动作缺少确认档位: ' + action)
      continue
    }
    if (!CONFIRM_LEVELS.includes(level)) problems.push('动作的确认档位非法: ' + action + ' -> ' + String(level))
    // 不变量：control 平面上的动作不得低于 biometric
    if (ACTION_SCOPE[action] === 'control' && level !== 'biometric') {
      problems.push('control 类动作 ' + action + ' 的确认档位是 ' + level + '，低于 biometric')
    }
  }
  // 反向：表里不该有 ACTION_KINDS 之外的动作
  for (const key of Object.keys(ACTION_CONFIRM)) {
    if (!(ACTION_KINDS as readonly string[]).includes(key)) problems.push('确认策略表里有未知动作: ' + key)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 客户端据此决定"这次点击要不要先过强确认"。
 * @param action - 动作类型。
 * @param platform - 客户端平台（移动端有生物识别可用）。
 */
export function requiresBiometric(action: ActionKind, platform: 'web' | 'mobile'): boolean {
  const level = confirmLevelFor(action)
  if (level !== 'biometric') return false
  // 网页端没有生物识别：不假装有，而是退到 confirm（界面需提示"移动端需生物识别"）
  return platform === 'mobile'
}
