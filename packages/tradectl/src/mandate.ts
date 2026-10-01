/**
 * mandate：机器可用的授权信封（P3 步骤 1）。
 *
 * 三条不许妥协的规则（卡片原文）：
 *   1. **收紧自动生效、放宽必须重新签名** —— 由 isSubset 判定，且**未知字段视为放宽**。
 *      这条的立意是"授权只能被收窄，不能被自己悄悄放宽"：实现里对新型字段采取
 *      fail-closed（不认识就当作放宽），于是将来加字段不会因为"检查器不认识"而被绕过。
 *   2. **撤销默认 allow-reduce-only**（已裁决：不做"撤销即全平"）——撤销是收回开仓权，
 *      不是替人平仓；把"撤销"实现成全平等于让一个管理动作变成不可撤销的市场动作。
 *   3. **到期未续自动降为 reduce_only**，默认 30 天。
 *
 * 不变量：**下单意图里没有额度字段**（不可表达即不可自我扩权）——见 intent.ts 的
 * TradeIntent：它只有 symbol/side/quantity/type/价格，额度只存在于 mandate。
 *
 * Ed25519 的签名与验签**不在这里重复实现**：那是 @dshtrading/authority 的家
 * （canonicalize / signLiveTradingGrant / verifyLiveTradingGrant 一整套已存在）。
 * 本模块只负责 mandate 的**语义判定**（严格性、到期、撤销），并把签名当作已经验过的输入。
 *
 * @module @dshtrading/tradectl/mandate
 */
import { canonicalize } from '@dshtrading/authority'

/** 额度字段的类型学：每一种都有自己的"更严"方向。 */
export type ScopeFieldKind =
  | { readonly kind: 'upper'; readonly unit: string }
  | { readonly kind: 'set' }
  | { readonly kind: 'ladder'; readonly order: readonly string[] }
  | { readonly kind: 'closed'; readonly allowed: string }

/**
 * scope 字段表。**表即契约**：不在表里的键一律按"未知字段 ⇒ 放宽"处理（卡片要求），
 * 于是新增字段的人必须同时更新这张表，否则他的新字段会让所有 mandate 比较失败——
 * 这是有意的摩擦：放宽授权必须是一次显式的、经过评审的动作。
 */
export const SCOPE_FIELDS: Record<string, ScopeFieldKind> = {
  markets: { kind: 'set' },
  symbols: { kind: 'set' },
  windows: { kind: 'set' },
  notionalMax: { kind: 'upper', unit: 'quote-currency' },
  positionNotionalMax: { kind: 'upper', unit: 'quote-currency' },
  deskNotionalMax: { kind: 'upper', unit: 'quote-currency' },
  maxOpenOrders: { kind: 'upper', unit: 'count' },
  leverageMax: { kind: 'upper', unit: 'multiple' },
  escalation: { kind: 'ladder', order: ['none', 'notify', 'approve'] },
  revocation: { kind: 'closed', allowed: 'allow-reduce-only' },
}

/** 授权范围（全部是"上限/集合/阶梯"，没有一个是下限）。 */
export interface MandateScope {
  readonly markets: readonly string[]
  readonly symbols: readonly string[]
  readonly windows: readonly string[]
  readonly notionalMax: number
  readonly positionNotionalMax: number
  readonly deskNotionalMax: number
  readonly maxOpenOrders: number
  readonly leverageMax: number
  readonly escalation: string
  readonly revocation: string
}

/** 一份 mandate（版本链 + 范围 + 有效期 + 人类签名）。 */
export interface MandateDoc {
  readonly mandateVersion: number
  /** 上一版版本号；首版为 null。链式版本让"收紧"可以逐版追溯。 */
  readonly parentVersion: number | null
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly scope: MandateScope
  /** 签名由 @dshtrading/authority 验过；这里只记录它覆盖了哪份 canonical 载荷。 */
  readonly signature: { readonly keyId: string; readonly algorithm: 'ed25519'; readonly value: string }
}

/** 默认有效期：30 天。 */
export const MANDATE_DEFAULT_DAYS = 30

/** 比较结果：是否"至少一样严"，以及所有放宽点（逐条给人看，不是一句 false）。 */
export interface SubsetVerdict {
  readonly subset: boolean
  readonly widenings: readonly string[]
}

function compareValue(next: unknown, prev: unknown, path: string, kind: ScopeFieldKind): string[] {
  if (kind.kind === 'upper') {
    if (typeof next !== 'number' || typeof prev !== 'number') return [path + ': 上限字段必须是数字']
    if (!Number.isFinite(next) || next < 0) return [path + ': 上限必须是有限非负数']
    if (next > prev) return [path + ': ' + String(next) + ' > ' + String(prev) + ' (' + kind.unit + ')：放宽']
    return []
  }
  if (kind.kind === 'set') {
    if (!Array.isArray(next) || !Array.isArray(prev)) return [path + ': 集合字段必须是数组']
    const allowed = new Set(prev as unknown[])
    const added = (next as unknown[]).filter((item) => !allowed.has(item))
    return added.length === 0 ? [] : [path + ': 新增 ' + JSON.stringify(added) + '：放宽']
  }
  if (kind.kind === 'ladder') {
    const nextIndex = kind.order.indexOf(String(next))
    const prevIndex = kind.order.indexOf(String(prev))
    if (nextIndex < 0) return [path + ': 未知取值 ' + JSON.stringify(next) + '：放宽']
    if (prevIndex < 0) return [path + ': 上一版取值不在阶梯上，无法比较']
    return nextIndex < prevIndex ? [path + ': ' + String(next) + ' 比 ' + String(prev) + ' 更松：放宽'] : []
  }
  // closed：唯一允许的取值（例如 revocation 只能是 allow-reduce-only）
  return String(next) === kind.allowed ? [] : [path + ': 取值 ' + JSON.stringify(next) + ' 不在允许集合 {' + kind.allowed + '}：放宽']
}

/**
 * scope 的严格性比较（纯函数）：next 是否**不比** prev 松。逐字段给放宽点。
 * 未知字段（prev 或表里都没有的键）⇒ 放宽——这是"未知字段视为放宽"的落点。
 * @param next - 新版 scope。
 * @param prev - 上一版 scope。
 */
export function isScopeSubset(next: MandateScope, prev: MandateScope): SubsetVerdict {
  const widenings: string[] = []
  const nextRecord = next as unknown as Record<string, unknown>
  const prevRecord = prev as unknown as Record<string, unknown>
  for (const key of Object.keys(nextRecord)) {
    const kind = SCOPE_FIELDS[key]
    if (kind === undefined) {
      widenings.push(key + ': 未知字段（检查器不认识 ⇒ 按放宽处理）')
      continue
    }
    if (!(key in prevRecord)) {
      widenings.push(key + ': 上一版没有这个字段（新增 ⇒ 按放宽处理）')
      continue
    }
    widenings.push(...compareValue(nextRecord[key], prevRecord[key], key, kind))
  }
  return { subset: widenings.length === 0, widenings }
}

/**
 * 整份 mandate 的比较：版本链 + 有效期 + 范围。
 * 收紧（更早到期、更小范围）自动生效；任何放宽点为空才允许不重签。
 * @param next - 新版 mandate。
 * @param prev - 当前生效的 mandate。
 */
export function isMandateAtLeastAsStrict(next: MandateDoc, prev: MandateDoc): SubsetVerdict {
  const widenings: string[] = []
  if (next.parentVersion !== prev.mandateVersion) {
    widenings.push('parentVersion ' + String(next.parentVersion) + ' 不等于当前版本 ' + String(prev.mandateVersion) + '：版本链断裂')
  }
  if (next.mandateVersion <= prev.mandateVersion) {
    widenings.push('mandateVersion 必须递增（' + String(next.mandateVersion) + ' <= ' + String(prev.mandateVersion) + '）')
  }
  if (next.expiresAtMs > prev.expiresAtMs) {
    widenings.push('expiresAtMs 比上一版更晚：延长有效期属于放宽')
  }
  widenings.push(...isScopeSubset(next.scope, prev.scope).widenings)
  return { subset: widenings.length === 0, widenings }
}

/** mandate 的生效状态。 */
export type MandateState = 'active' | 'expired-reduce-only' | 'revoked-reduce-only'

/** 到期与撤销的判定结果。 */
export interface MandateEffect {
  readonly state: MandateState
  /** 是否仍可开新仓（到期/撤销后为 false）。 */
  readonly mayOpenNewRisk: boolean
  /** 是否仍可减仓（到期/撤销后仍然可以——撤销是收回开仓权，不是把人锁在仓位里）。 */
  readonly mayReduce: boolean
  readonly reason: string
}

/**
 * 到期判定：到期未续 ⇒ reduce_only（不是 halt，也不是"可继续开仓"）。
 * @param mandate - 当前 mandate。
 * @param nowMs - 注入时钟。
 */
export function evaluateMandate(mandate: MandateDoc, nowMs: number): MandateEffect {
  if (nowMs >= mandate.expiresAtMs) {
    return {
      state: 'expired-reduce-only',
      mayOpenNewRisk: false,
      mayReduce: true,
      reason: 'mandate expired at ' + String(mandate.expiresAtMs) + ': reduce_only until renewed',
    }
  }
  return { state: 'active', mayOpenNewRisk: true, mayReduce: true, reason: 'mandate is within its validity window' }
}

/**
 * 撤销语义（已裁决：默认 allow-reduce-only）。做成纯函数而不是"标记字段"，
 * 是为了让"撤销 ≠ 全平"这条裁决有一个可断言的落点。
 * @param mandate - 被撤销的 mandate。
 */
export function revokeMandate(mandate: MandateDoc): MandateEffect {
  return {
    state: 'revoked-reduce-only',
    mayOpenNewRisk: false,
    mayReduce: true,
    reason: 'mandate revoked (' + mandate.scope.revocation + '): open authority withdrawn, existing positions are not force-closed',
  }
}

/** mandate 的 canonical 载荷（签名覆盖的就是它，交给 authority 签/验）。 */
export function mandateSigningPayload(mandate: Omit<MandateDoc, 'signature'>): string {
  return canonicalize(mandate)
}
