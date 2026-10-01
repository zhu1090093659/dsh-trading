/**
 * 推送通知载荷（P4 步骤 4 的契约面）。
 *
 * 卡片对通知的要求是"携带类型 / 严重度 / deskId / 深链 / 倒计时 / 可用动作"——
 * 这份载荷是**移动端与推送服务之间的契约**，与内部分发方式无关，所以它可以先落地并被断言。
 *
 * 三条设计立场：
 *   1. **封闭枚举**：severity 与 kind 都是封闭集合。推送是最容易被"顺手加个字段"的通道，
 *      而通知里的**可用动作**决定了用户点一下会发生什么 —— 它必须是可校验的，不能自由发挥。
 *   2. **倒计时只表达"还剩多久"，不表达"到点自动做什么"**：动作永远由人按下确认，
 *      通知里带一个"自动执行"的语义等于把授权放进了推送通道。
 *   3. **深链只允许应用内路径**：%%deeplink%% 必须是 %%dshtrading://%% 前缀。允许 http(s)
 *      等于允许推送服务把用户送去任意站点（推送通道的信任级别不该那么高）。
 *
 * @module @dshtrading/contract/push
 */
/** 严重度：封闭三档。 */
export const PUSH_SEVERITIES = ['info', 'warning', 'critical'] as const
export type PushSeverity = (typeof PUSH_SEVERITIES)[number]

/** 通知类型：封闭集合（与驾驶舱卡片类型同源，但不相等 —— 推送只推需要人立刻知道的）。 */
export const PUSH_KINDS = ['escalation', 'degradation', 'kill-confirmed', 'mandate-expiring', 'stale-data'] as const
export type PushKind = (typeof PUSH_KINDS)[number]

/** 允许的应用内深链前缀（只允许应用内，不允许把用户送去任意站点）。 */
export const DEEPLINK_SCHEME = 'dshtrading://'

/** 通知里可以出现的动作（与卡片的 ActionKind 取交集：推送只承载"需要人立刻决断"的动作）。 */
export const PUSH_ACTIONS = ['ack', 'approve', 'reject', 'pause', 'kill'] as const
export type PushAction = (typeof PUSH_ACTIONS)[number]

/** 一条推送载荷。 */
export interface PushPayload {
  readonly kind: PushKind
  readonly severity: PushSeverity
  readonly deskId: string
  /** 应用内深链（必须以 dshtrading:// 开头）。 */
  readonly deeplink: string
  /** 倒计时：多少毫秒后这条通知失去时效（**只表达时限，不表达自动动作**）。 */
  readonly expiresInMs: number
  /** 通知上可以直接按的动作（人按下才生效；空数组表示只能打开应用处理）。 */
  readonly actions: readonly PushAction[]
  /** 必填：通知被系统折叠/截断时显示的纯文本。 */
  readonly fallbackText: string
  /** 同一业务对象的重绘版本（客户端据此丢弃乱序到达的旧通知）。 */
  readonly revision: number
}

/** 校验结果。 */
export interface PushVerdict {
  readonly valid: boolean
  readonly problems: readonly string[]
}

/** 通知里的硬上限（与卡片协议同样的棘轮思路）。 */
export const PUSH_LIMITS = {
  maxActions: 3,
  maxFallbackChars: 180,
  maxDeeplinkChars: 256,
  maxDeskIdChars: 64,
  maxExpiresInMs: 24 * 60 * 60 * 1000,
} as const

const SEVERITY_SET = new Set<string>(PUSH_SEVERITIES)
const KIND_SET = new Set<string>(PUSH_KINDS)
const ACTION_SET = new Set<string>(PUSH_ACTIONS)

/**
 * 校验一条推送载荷。
 * @param payload - 待校验载荷。
 */
export function validatePushPayload(payload: PushPayload): PushVerdict {
  const problems: string[] = []
  if (!KIND_SET.has(String(payload.kind))) problems.push('未知 kind: ' + String(payload.kind))
  if (!SEVERITY_SET.has(String(payload.severity))) problems.push('未知 severity: ' + String(payload.severity))
  if (typeof payload.deskId !== 'string' || payload.deskId === '' || payload.deskId.length > PUSH_LIMITS.maxDeskIdChars) {
    problems.push('deskId 必填且不超过 ' + String(PUSH_LIMITS.maxDeskIdChars) + ' 字符')
  }
  if (typeof payload.deeplink !== 'string' || !payload.deeplink.startsWith(DEEPLINK_SCHEME)) {
    problems.push('deeplink 必须以 ' + DEEPLINK_SCHEME + ' 开头（不允许外部链接）')
  } else if (payload.deeplink.length > PUSH_LIMITS.maxDeeplinkChars) {
    problems.push('deeplink 超过 ' + String(PUSH_LIMITS.maxDeeplinkChars) + ' 字符')
  }
  if (typeof payload.expiresInMs !== 'number' || !Number.isFinite(payload.expiresInMs) || payload.expiresInMs <= 0) {
    problems.push('expiresInMs 必须是正的有限数')
  } else if (payload.expiresInMs > PUSH_LIMITS.maxExpiresInMs) {
    problems.push('expiresInMs 超过上限 ' + String(PUSH_LIMITS.maxExpiresInMs))
  }
  if (!Array.isArray(payload.actions)) {
    problems.push('actions 必须是数组（可以是空数组）')
  } else if (payload.actions.length > PUSH_LIMITS.maxActions) {
    problems.push('actions 超过 ' + String(PUSH_LIMITS.maxActions) + ' 个')
  } else {
    for (const action of payload.actions) {
      if (!ACTION_SET.has(String(action))) problems.push('未知 action: ' + String(action))
    }
  }
  // critical 通知必须至少给一个人能按的动作：只喊危险而不给出口，等于把人钉在原地
  if (payload.severity === 'critical' && Array.isArray(payload.actions) && payload.actions.length === 0) {
    problems.push('critical 通知必须至少有一个可用动作')
  }
  if (typeof payload.fallbackText !== 'string' || payload.fallbackText.trim() === '') {
    problems.push('fallbackText 必填')
  } else if (payload.fallbackText.length > PUSH_LIMITS.maxFallbackChars) {
    problems.push('fallbackText 超过 ' + String(PUSH_LIMITS.maxFallbackChars) + ' 字符')
  }
  if (typeof payload.revision !== 'number' || !Number.isFinite(payload.revision) || payload.revision < 0) {
    problems.push('revision 必须是非负有限数')
  }
  return { valid: problems.length === 0, problems }
}

/**
 * 客户端决定"这条通知值不值得叫醒用户"——**只做展示层筛选，不做业务判断**。
 * @param payload - 载荷。
 * @param muted - 用户已静音的 desk 集合（critical 不受静音影响）。
 */
export function shouldInterrupt(payload: PushPayload, muted: readonly string[]): boolean {
  if (payload.severity === 'critical') return true
  return !muted.includes(payload.deskId)
}
