/**
 * @dshtrading/client-ui-bot-gui 最小封闭契约类型面。
 * 对齐卫星仓 packages/contract（封闭 CardType / FieldKind / ActionKind / ConfirmLevel 等）。
 * 保持封闭枚举语义与硬上限判据，零第三方依赖。
 */

export const CARD_TYPES = [
  'desk-summary',
  'risk-state',
  'decision',
  'trigger-trace',
  'position',
  'order',
  'mandate-status',
  'escalation',
  'journal-gap',
  'freshness',
  'control-panel',
  'system-notice',
] as const
export type CardType = (typeof CARD_TYPES)[number]

export const FIELD_KINDS = [
  'text',
  'number',
  'currency',
  'percent',
  'timestamp',
  'duration',
  'severity',
  'status',
  'bool',
  'symbol',
  'id-ref',
  'enum',
] as const
export type FieldKind = (typeof FIELD_KINDS)[number]

export const ACTION_KINDS = [
  'ack',
  'dismiss',
  'open-detail',
  'retry-sync',
  'approve',
  'reject',
  'pause',
  'resume',
  'kill',
  'flatten',
  'grant-control',
  'revoke-device',
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export const CONFIRM_LEVELS = ['none', 'confirm', 'biometric'] as const
export type ConfirmLevel = (typeof CONFIRM_LEVELS)[number]

export const ACTION_CONFIRM: Record<ActionKind, ConfirmLevel> = {
  ack: 'none',
  dismiss: 'none',
  'open-detail': 'none',
  'retry-sync': 'none',
  approve: 'biometric',
  reject: 'biometric',
  pause: 'biometric',
  resume: 'biometric',
  kill: 'biometric',
  flatten: 'biometric',
  'grant-control': 'biometric',
  'revoke-device': 'biometric',
}

export function confirmLevelFor(action: ActionKind): ConfirmLevel {
  return ACTION_CONFIRM[action] ?? 'biometric'
}

export interface CardField {
  readonly key: string
  readonly label: string
  readonly kind: FieldKind
  readonly value: unknown
  readonly values?: readonly string[] | undefined
  readonly unit?: string | undefined
}

export interface CardAction {
  readonly kind: ActionKind
  readonly label: string
  readonly params?: Readonly<Record<string, unknown>> | undefined
  readonly confirm?: boolean | undefined
}

export interface Card {
  readonly cardId: string
  readonly cardType: CardType
  readonly revision: number
  readonly fallbackText: string
  readonly fields: readonly CardField[]
  readonly actions: readonly CardAction[]
  readonly display?: Readonly<Record<string, unknown>> | undefined
  readonly freshnessMs?: number | undefined
}

export const CARD_LIMITS = {
  maxFields: 24,
  maxActions: 6,
  maxFallbackChars: 512,
  maxLabelChars: 64,
  maxValueChars: 256,
  maxCardsPerPage: 50,
  maxTextChars: 1024,
  maxEnumValues: 24,
  maxDepth: 3,
  maxCardBytes: 16_384,
  maxIdChars: 64,
  maxActionParams: 8,
} as const

export const ALL_ACTION_CAPS = ACTION_KINDS.map((kind) => 'action:' + kind).join(',')

/** modules.d.ts for CSS module types */
