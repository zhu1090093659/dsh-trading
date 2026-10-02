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
 * 本模块只负责 mandate 的**语义判定**（严格性、到期、撤销、额度上限），并把签名当作
 * 已经验过的输入。
 *
 * @module @dshtrading/tradectl/mandate
 */
import { canonicalize } from '@dshtrading/authority'
import { firstLimitHit, type LimitInputs, type LimitName } from './shadow.ts'

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

/* ------------------------------------------- 额度上限：可执行判据（缺省即拒绝） */

/**
 * 限额字段集 = `SCOPE_FIELDS` 里所有 `upper` 字段（**派生**，不是第二张表）。
 *
 * 它恰好就是 `firstLimitHit` 判定时读的那几个字段：任何一个缺席，对应那条判定就变成
 * 真空（`x > undefined` 恒假 ⇒ 静默放行），所以它同时是"必须显式声明"的清单。
 */
export const MANDATE_LIMIT_FIELDS: readonly string[] = Object.entries(SCOPE_FIELDS)
  .filter(([, kind]) => kind.kind === 'upper')
  .map(([name]) => name)

/** 从字段表取单位；上限字段才有单位。 */
function unitOf(field: string): string {
  const kind = SCOPE_FIELDS[field]
  return kind !== undefined && kind.kind === 'upper' ? kind.unit : 'unknown-unit'
}

/**
 * 上限声明的解析结果：要么表里的上限字段齐全且合法，要么点名缺了什么 ⇒ 拒绝。
 *
 * **单位与币种口径**（不要自己发明第二套）：三个 notional 上限的单位是
 * `quote-currency`（计价货币），与 `notional = quantity × price` 同口径、与敞口快照
 * （positionNotional / deskNotional）同口径；`maxOpenOrders` 是 `count`、
 * `leverageMax` 是 `multiple`。判定器**不做汇率换算**——没有汇率来源时，猜一个
 * 汇率比拒绝更危险；跨币种（例如 USDT 与 USD 混算）必须在 mandate 层面统一，
 * 由调用方把敞口折算到同一个计价货币后再传进来。
 */
export type MandateLimitsResolution =
  | { readonly declared: true; readonly limits: LimitInputs['limits'] }
  | { readonly declared: false; readonly missing: readonly string[]; readonly invalid: readonly string[]; readonly reason: string }

/**
 * 把 mandate 声明的上限读出来；缺一个就不算声明过。
 *
 * **缺省语义（本模块的裁决）：没有声明上限 ⇒ 拒绝开新仓，不是"默认无限"。**
 * 理由：没写进 mandate 的上限不受签名覆盖，任何"缺了当无限"的读法都会把一次漏写字段
 * 变成一次无人授权的扩权；而拒绝开新仓的代价只是"回去补签一份 mandate"。这也是
 * "签了实盘 grant 不等于有限额"缺口的落点：grant 只回答"能不能实盘"，上限必须由
 * mandate 的 upper 字段显式回答。
 *
 * 合法取值 = **有限非负数**（与 isScopeSubset 对 upper 的规则同一套）：`Infinity` /
 * `NaN` / 负数 / 非数字一律算未声明（`Infinity` 正是"无限"的写法，是这里要挡的东西）；
 * **`0` 是合法声明**，含义是"不允许任何正数新增名义额"，与"没写这个字段"必须区分开。
 * @param mandate - 待解析的 mandate。
 */
export function resolveMandateLimits(mandate: MandateDoc): MandateLimitsResolution {
  const scope = mandate.scope as unknown as Record<string, unknown>
  const missing: string[] = []
  const invalid: string[] = []
  for (const field of MANDATE_LIMIT_FIELDS) {
    const value = scope[field]
    if (value === undefined || value === null) {
      missing.push(field)
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      invalid.push(field + '=' + JSON.stringify(value) + '（单位 ' + unitOf(field) + '）')
    }
  }
  if (missing.length > 0 || invalid.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push('缺 ' + missing.join('、'))
    if (invalid.length > 0) parts.push('非法 ' + invalid.join('、'))
    return {
      declared: false,
      missing,
      invalid,
      reason: 'mandate 未完整声明额度上限（' + parts.join('；') + '）：缺省语义是拒绝开新仓，不是无限',
    }
  }
  const limits: Record<string, number> = {}
  for (const field of MANDATE_LIMIT_FIELDS) limits[field] = scope[field] as number
  return { declared: true, limits: limits as unknown as LimitInputs['limits'] }
}

/** 一次拟新增风险的提案（形状与 shadow 的 DecisionCard.action 同构：判定只有一个家）。 */
export interface OpenRiskProposal {
  readonly kind: 'open' | 'reduce' | 'hold'
  readonly symbol: string
  readonly quantity: number
  /** 名义额 = 数量 × 价格，计价货币口径（见 resolveMandateLimits 的单位说明）。 */
  readonly notional: number
}

/** 判定时刻的敞口快照（判定所需的最小输入，单位与上限同口径）。 */
export interface OpenRiskExposure {
  readonly positionNotional: number
  readonly deskNotional: number
  readonly openOrders: number
  readonly leverage: number
}

/** 开新仓判定请求：mandate + 注入时钟 + 提案 + 敞口。 */
export interface OpenRiskRequest {
  readonly mandate: MandateDoc
  readonly atMs: number
  readonly proposal: OpenRiskProposal
  readonly exposure: OpenRiskExposure
}

/**
 * 拒绝码里属于本模块（而不是某条上限）的那几个：
 *   - `mandate-not-active`：有效期已过（原因取自 evaluateMandate）；撤销是另一条纯函数
 *     `revokeMandate` 的结论，调用方把它并进来（两者都只挡开新仓）；
 *   - `no-declared-limit`：上限没被完整声明（缺省即拒绝）；
 *   - `invalid-input`：提案或敞口的数值不可信（NaN/负数会让所有比较为假）。
 */
export type MandateRefusalCode = 'mandate-not-active' | 'no-declared-limit' | 'invalid-input'

/**
 * 拒绝时能出现的限额名 = `LimitName` 里除 `none` 之外的全部（`none` 是放行，不是拒绝）。
 * `riskGate` 由档位判定产出、不由本判定器产出，但它同样落进"非 `none` 即拒绝"这一侧 ——
 * 不认识的拒绝码不会因为"不是金额"就变成放行。
 */
export type MandateLimitName = Exclude<LimitName, 'none'>

export type OpenRiskVerdict =
  | { readonly allowed: true; readonly limitHit: 'none'; readonly reason: string }
  | { readonly allowed: false; readonly limitHit: MandateLimitName | MandateRefusalCode; readonly reason: string }

/**
 * 判定器自己的输入检查：`NaN` / `Infinity` / 负数会让所有比较为假 ⇒ 与"缺上限"同等
 * 对待（拒绝）。这不是重复校验，是判定成立的前提——拿不到可信的数就不放行。
 */
function invalidJudgeInputs(proposal: OpenRiskProposal, exposure: OpenRiskExposure): string[] {
  const problems: string[] = []
  if (!Number.isFinite(proposal.notional) || proposal.notional <= 0) {
    problems.push('proposal.notional=' + String(proposal.notional) + ' 不是有限正数')
  }
  const measures: ReadonlyArray<readonly [string, number]> = [
    ['positionNotional', exposure.positionNotional],
    ['deskNotional', exposure.deskNotional],
    ['openOrders', exposure.openOrders],
    ['leverage', exposure.leverage],
  ]
  for (const [name, value] of measures) {
    if (!Number.isFinite(value) || value < 0) problems.push(name + '=' + String(value) + ' 不是有限非负数')
  }
  return problems
}

/** 人读的一行上限摘要（放行时告诉人"在什么之内放行的"）。 */
function describeDeclaredLimits(limits: LimitInputs['limits']): string {
  const record = limits as unknown as Record<string, number>
  return MANDATE_LIMIT_FIELDS.map((field) => field + '=' + String(record[field])).join(', ')
}

/**
 * 开新仓授权判定：**有效期/撤销 ∧ 上限已被声明 ∧ 未超上限**的合取。
 *
 * 三个事实各回各家：有效期与撤销取 `evaluateMandate`、限额比较取 `firstLimitHit`
 * （限额判定顺序的唯一家，见 shadow.ts——本模块不复制那五个比较）；本函数只补上
 * **"上限是否被显式声明"**这段 fail-closed 前置，并把三者合成一个可执行结论。
 * 因此新增上限字段时只需要改 `SCOPE_FIELDS` 一处，这里自动跟上。
 *
 * 只约束**新增风险**：`reduce` / `hold` 在解析上限之前就放行——到期与撤销都不得被读成
 * "把人锁在仓位里"（见本模块头部的第 2 条裁决），降风险永远不需要额度。
 * @param request - mandate、注入时钟、提案与敞口快照。
 */
export function openRiskWithinMandate(request: OpenRiskRequest): OpenRiskVerdict {
  const { mandate, atMs, proposal, exposure } = request
  if (proposal.kind !== 'open') {
    return { allowed: true, limitHit: 'none', reason: proposal.kind + ' 不新增风险：上限与有效期只约束开新仓' }
  }
  const invalidInput = invalidJudgeInputs(proposal, exposure)
  if (invalidInput.length > 0) {
    return { allowed: false, limitHit: 'invalid-input', reason: '判定输入不可信（' + invalidInput.join('；') + '）：拿不到可信的数就不放行' }
  }
  const effect = evaluateMandate(mandate, atMs)
  if (!effect.mayOpenNewRisk) {
    return { allowed: false, limitHit: 'mandate-not-active', reason: effect.reason }
  }
  const resolution = resolveMandateLimits(mandate)
  if (!resolution.declared) {
    return { allowed: false, limitHit: 'no-declared-limit', reason: resolution.reason }
  }
  const limitHit = firstLimitHit(proposal, { limits: resolution.limits, ...exposure })
  if (limitHit === 'none') {
    return { allowed: true, limitHit: 'none', reason: '在 mandate 声明的上限内（' + describeDeclaredLimits(resolution.limits) + '）' }
  }
  return { allowed: false, limitHit, reason: '被 ' + limitHit + ' 挡下（单位 ' + unitOf(limitHit) + '）：新增风险未获额度' }
}
