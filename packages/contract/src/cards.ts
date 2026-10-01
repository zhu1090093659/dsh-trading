/**
 * 服务端驱动卡片协议（P4 步骤 2）。
 *
 * 三条设计立场：
 *   1. **服务端驱动、客户端只渲染**：卡片是数据，不是模板/HTML/布局 DSL。客户端不认识
 *      的东西一律**渲染成不可操作态**，而不是"尽力猜一个样子"——猜出来的界面会让用户
 *      以为自己看到的是全部。
 *   2. **封闭枚举**：CardType / FieldKind / ActionKind 都是封闭联合。新增类型 = 契约变更，
 *      要走版本协商；"未知枚举值"不是错误而是**信号**：它说明客户端太旧，于是禁用全部
 *      Action（只读展示 + fallbackText），并把升级诉求交给 426/caps 机制表达。
 *   3. **必填 fallbackText**：任何卡片都必须能在"客户端完全不会渲染这张卡"时退化成一句
 *      纯文本。没有兜底的富卡片等于"老客户端上什么都不显示"。
 *
 * 4 条"不退化"规则全部可机检（见 validateCard），12 个硬上限是棘轮（见 CARD_LIMITS）：
 * 上限只许降不许升，超限的卡片直接判为非法——不做截断，截断会把"超限"变成静默降级。
 *
 * @module @dshtrading/contract/cards
 */
import type { ScopePlane } from './scopes.ts'

/** 12 个封闭卡片类型。 */
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

/** 封闭字段类型（没有 html/template/raw 这类逃生口）。 */
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

/** 封闭动作类型。 */
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

/** 动作需要的作用域（客户端据此判断自己能不能按；服务端仍会再校验一次）。 */
export const ACTION_SCOPE: Record<ActionKind, ScopePlane> = {
  ack: 'read',
  dismiss: 'read',
  'open-detail': 'read',
  'retry-sync': 'read',
  approve: 'command',
  reject: 'command',
  pause: 'control',
  resume: 'control',
  kill: 'control',
  flatten: 'control',
  'grant-control': 'control',
  'revoke-device': 'control',
}

/** 12 个硬上限（棘轮：只许降不许升；超限即非法，不截断）。 */
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

/** 一个字段。 */
export interface CardField {
  readonly key: string
  readonly label: string
  readonly kind: FieldKind
  readonly value: unknown
  /** %%kind === 'enum'%% 时必须给出允许值集合。 */
  readonly values?: readonly string[] | undefined
  /** 数值/时间类字段的展示单位（仅展示，不参与语义）。 */
  readonly unit?: string | undefined
}

/** 一个动作。 */
export interface CardAction {
  readonly kind: ActionKind
  readonly label: string
  readonly params?: Readonly<Record<string, unknown>> | undefined
  /** 是否需要二次确认（控制类动作必须为 true）。 */
  readonly confirm?: boolean | undefined
}

/** 一张卡片。 */
export interface Card {
  readonly cardId: string
  readonly cardType: CardType
  /** 同一卡片的重绘版本（只增不减，客户端据此丢弃乱序到达的旧版本）。 */
  readonly revision: number
  /** 必填：客户端不会渲染时的纯文本兜底。 */
  readonly fallbackText: string
  readonly fields: readonly CardField[]
  readonly actions: readonly CardAction[]
  /** open 类扩展：仅在超出客户端 caps 时下发（客户端不认识就忽略）。 */
  readonly display?: Readonly<Record<string, unknown>> | undefined
  /** 数据新鲜度（观测面不依赖 tick 流，靠这个字段表达"我看到的是多久前的"）。 */
  readonly freshnessMs?: number | undefined
}

/** 校验结果：非法卡片附原因；**可渲染但不可操作**是另一回事（见 operable）。 */
export interface CardVerdict {
  readonly valid: boolean
  readonly operable: boolean
  readonly problems: readonly string[]
}

const CARD_TYPE_SET = new Set<string>(CARD_TYPES)
const FIELD_KIND_SET = new Set<string>(FIELD_KINDS)
const ACTION_KIND_SET = new Set<string>(ACTION_KINDS)

/**
 * 校验一张卡片：4 条"不退化"规则 + 12 个硬上限。
 * 规则 1：cardType/fieldKind/actionKind 必须是封闭枚举值 —— **未知值 ⇒ 不可操作**
 *   （valid 仍可为 true：卡片本身结构合法，只是"我这一版客户端不认识"，于是禁用全部 Action）。
 * 规则 2：%%enum%% 字段必须带非空 %%values%%，且值必须在其中。
 * 规则 3：%%fallbackText%% 必填非空且不超长。
 * 规则 4：控制类动作必须 %%confirm: true%%（kill/pause/flatten 这类不允许一键触发）。
 * @param card - 待校验卡片。
 * @param limits - 覆盖上限（测试用；生产用 CARD_LIMITS）。
 */
export function validateCard(card: Card, limits: typeof CARD_LIMITS = CARD_LIMITS): CardVerdict {
  const problems: string[] = []
  let operabilityBlocked = false

  if (typeof card.cardId !== 'string' || card.cardId === '' || card.cardId.length > limits.maxIdChars) {
    problems.push('cardId 必填且不超过 ' + String(limits.maxIdChars) + ' 字符')
  }
  if (!CARD_TYPE_SET.has(String(card.cardType))) {
    // 未知卡片类型：整张卡都不可渲染，谈不上操作。
    problems.push('未知 cardType: ' + String(card.cardType))
    operabilityBlocked = true
  }
  if (typeof card.revision !== 'number' || !Number.isFinite(card.revision) || card.revision < 0) {
    problems.push('revision 必须是非负有限数')
  }
  if (typeof card.fallbackText !== 'string' || card.fallbackText.trim() === '') {
    problems.push('fallbackText 必填（客户端不会渲染时要有纯文本兜底）')
  } else if (card.fallbackText.length > limits.maxFallbackChars) {
    problems.push('fallbackText 超过 ' + String(limits.maxFallbackChars) + ' 字符上限')
  }
  if (!Array.isArray(card.fields) || card.fields.length > limits.maxFields) {
    problems.push('fields 不得超过 ' + String(limits.maxFields) + ' 条')
  }
  if (!Array.isArray(card.actions) || card.actions.length > limits.maxActions) {
    problems.push('actions 不得超过 ' + String(limits.maxActions) + ' 条')
  }
  for (const field of card.fields ?? []) {
    if (!FIELD_KIND_SET.has(String(field.kind))) {
      problems.push('未知 fieldKind: ' + String(field.kind))
      operabilityBlocked = true
      continue
    }
    if (typeof field.label !== 'string' || field.label.length > limits.maxLabelChars) {
      problems.push('字段 ' + String(field.key) + ' 的 label 超过 ' + String(limits.maxLabelChars) + ' 字符上限')
    }
    if (typeof field.value === 'string' && field.value.length > limits.maxValueChars) {
      problems.push('字段 ' + String(field.key) + ' 的值超过 ' + String(limits.maxValueChars) + ' 字符上限')
    }
    if (field.kind === 'enum') {
      const values = field.values
      if (!Array.isArray(values) || values.length === 0) {
        problems.push('enum 字段 ' + String(field.key) + ' 必须给出 values')
        operabilityBlocked = true
      } else if (values.length > limits.maxEnumValues) {
        problems.push('enum 字段 ' + String(field.key) + ' 的 values 超过 ' + String(limits.maxEnumValues) + ' 个')
      } else if (!values.includes(String(field.value))) {
        // 值不在允许集合里：客户端无法判断该显示成什么 ⇒ 不可操作。
        problems.push('enum 字段 ' + String(field.key) + ' 的值 ' + String(field.value) + ' 不在 values 内')
        operabilityBlocked = true
      }
    }
  }
  for (const action of card.actions ?? []) {
    if (!ACTION_KIND_SET.has(String(action.kind))) {
      problems.push('未知 actionKind: ' + String(action.kind))
      operabilityBlocked = true
      continue
    }
    const scope = ACTION_SCOPE[action.kind as ActionKind]
    if (scope === 'control' && action.confirm !== true) {
      problems.push('控制类动作 ' + String(action.kind) + ' 必须 confirm: true（不允许一键触发）')
      operabilityBlocked = true
    }
    if (action.params !== undefined) {
      const size = Object.keys(action.params).length
      if (size > limits.maxActionParams) problems.push('动作 ' + String(action.kind) + ' 的 params 超过 ' + String(limits.maxActionParams) + ' 项')
    }
  }
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
  } catch {
    problems.push('卡片无法序列化（可能存在循环引用）')
  }
  if (bytes > limits.maxCardBytes) {
    problems.push('卡片体积 ' + String(bytes) + ' 超过 ' + String(limits.maxCardBytes) + ' 字节上限')
  }
  const valid = problems.length === 0
  // 规则 1 的落点：**任何**未知封闭枚举值 ⇒ 不可操作（禁用全部 Action）。
  return { valid, operable: valid && !operabilityBlocked, problems }
}

/**
 * 客户端可渲染的动作列表：卡片非法或含未知枚举 ⇒ 空数组（禁用全部 Action）。
 * 再按客户端 caps 过滤（客户端没有的能力不显示按钮）。
 * @param card - 卡片。
 * @param clientCaps - 客户端能力集合（来自 X-Dsht-Caps）。
 * @param limits - 覆盖上限。
 */
export function renderableActions(card: Card, clientCaps: readonly string[], limits: typeof CARD_LIMITS = CARD_LIMITS): readonly CardAction[] {
  const verdict = validateCard(card, limits)
  if (!verdict.operable) return []
  const caps = new Set(clientCaps)
  return (card.actions ?? []).filter((action) => caps.has('action:' + action.kind) || caps.has('action:*'))
}

/** 客户端不会渲染这张卡时给用户的文本（这就是 fallbackText 的用处）。 */
export function fallbackFor(card: Card): string {
  const verdict = validateCard(card)
  if (verdict.valid && verdict.operable) return card.fallbackText
  return card.fallbackText.trim() === '' ? '（这张卡片无法显示，请升级客户端）' : card.fallbackText + '（部分内容无法显示：请升级客户端）'
}
