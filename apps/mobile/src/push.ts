/**
 * 收到推送后 App 该做什么。
 *
 * **判据全部来自契约**：载荷是否合法（validatePushPayload）、该不该打断用户
 * （shouldInterrupt：critical 永远打断，其余看静音）、深链指向哪个屏幕（parseDeeplink，
 * 只认本 App scheme 的开放集 —— 外部链接一律不打开）。
 * 这里只做一件事：把三者的结论合成一个"打开 / 丢弃"的决定，并把丢弃原因说清楚。
 */
import {
  parseDeeplink,
  shouldInterrupt,
  validatePushPayload,
  type DeeplinkScreen,
  type PushPayload,
} from '@dshtrading/contract/core'

export type PushDecision =
  | { readonly kind: 'drop'; readonly reason: string }
  | {
      readonly kind: 'open'
      readonly screen: DeeplinkScreen
      readonly interrupt: boolean
      readonly critical: boolean
      /** 重绘版本：客户端据此丢弃乱序到达的旧通知。 */
      readonly revision: number
    }

export interface PushHandlingOptions {
  /** 用户已静音的 deskId 列表（critical 不受静音影响）。 */
  readonly muted: readonly string[]
}

/**
 * 处理一条推送。
 * @param payload - 推送载荷（可能来自任何地方，因此必须校验）。
 * @param options - 静音列表。
 */
export function handlePush(payload: PushPayload, options: PushHandlingOptions): PushDecision {
  const verdict = validatePushPayload(payload)
  if (!verdict.valid) {
    // 非法载荷：丢弃并说清原因（不猜、不"尽力而为"地打开）
    return { kind: 'drop', reason: '载荷非法：' + verdict.problems.join('；') }
  }

  const parsed = parseDeeplink(payload.deeplink)
  if (!parsed.ok) {
    // 深链不在本 App 的开放集内（含外部链接）：不打开
    return { kind: 'drop', reason: '深链不可用：' + parsed.reason }
  }

  return {
    kind: 'open',
    screen: parsed.screen,
    interrupt: shouldInterrupt(payload, options.muted),
    critical: payload.severity === 'critical',
    revision: payload.revision,
  }
}
