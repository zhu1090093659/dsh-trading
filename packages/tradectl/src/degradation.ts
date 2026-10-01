/**
 * 降级语义与「四条禁止的降级」启动断言（P2 步骤 5）。
 *
 * 事实来源：docs/design/bot-and-auto-trading.md §13 #18 / #19 / #24 / #25。这里的每条
 * 断言都对应清单里的一句话——不变量若不以可执行断言的形式进 CI，它与散文无异。
 *
 * #18 四条**禁止**的降级（启动即断言，违者拒绝启动而不是"警告后继续"）：
 *   1. 权限不符不得降级为无鉴权；
 *   2. 核心不可达不得由宿主自行下单；
 *   3. 凭据只住核心侧；
 *   4. 独立 uid 不可用必须**显式声明**为开发形态。
 *
 * #19 控制面不可达 ≠ 授权失效：朝风险更低一侧降级（默认不再新增风险、保留保护性挂单）；
 *     dead-man 的触发条件是 **bot 自己心跳失活**，不是"手机连不上"。
 *
 * #24 降级自愈不闩锁：只降级肇事标的；全局触顶不得让整个 desk 丧失开仓能力（否则单标的
 *     即可 DoS 整个 desk）；连续禁开新仓超过 T 秒必须升级到人。
 *
 * #25 **halt 只由带外触发**：自动路径上永不可达——任何自动降级封顶 reduce_only。
 *
 * @module @dshtrading/tradectl/degradation
 */
import { readKillState, type KillState } from './edge.ts'

/** 风险档位。halt = 全停（只可能来自带外）。 */
export type RiskMode = 'normal' | 'reduce_only' | 'halt'

/** 触发源。除 out-of-band-halt 外，全部是自动路径。 */
export type DegradationTrigger =
  | 'market-stale'
  | 'venue-error'
  | 'model-api-down'
  | 'control-plane-unreachable'
  | 'core-restart'
  | 'disk-full'
  | 'clock-drift'
  | 'heartbeat-lost'
  | 'out-of-band-halt'

/** 触发源的作用范围：单标的 vs 全局。 */
export interface TriggerContext {
  readonly trigger: DegradationTrigger
  /** 单标的触发时给标的；全局故障（磁盘满/时钟漂移/核心重启）不给。 */
  readonly symbol?: string | undefined
  /** 该标的连续被禁开新仓的时长（毫秒，注入时钟算出来的）。 */
  readonly reduceOnlyForMs?: number | undefined
}

/** 升级到人的阈值（#24：连续禁开新仓超过 T 秒必须升级）。 */
export const ESCALATE_AFTER_MS = 10 * 60 * 1000

/** 一次降级决策。 */
export interface DegradationDecision {
  readonly mode: RiskMode
  readonly scope: 'symbol' | 'global'
  readonly symbol?: string | undefined
  /** 是否保留保护性挂单（#19：默认保留）。 */
  readonly keepProtectiveOrders: boolean
  /** 是否可以新增风险。 */
  readonly mayOpenNewRisk: boolean
  /** 是否需要升级到人。 */
  readonly escalateToHuman: boolean
  readonly reason: string
}

/**
 * 决策表（纯函数）。两条硬边界：
 *   - 自动触发**封顶** reduce_only（#25）；
 *   - 单标的故障只降级该标的（#24），不牵连全局。
 * @param context - 触发源与其作用范围。
 */
export function decideDegradation(context: TriggerContext): DegradationDecision {
  const scoped = context.symbol !== undefined
  const base = {
    scope: scoped ? ('symbol' as const) : ('global' as const),
    ...(context.symbol === undefined ? {} : { symbol: context.symbol }),
    keepProtectiveOrders: true,
  }
  if (context.trigger === 'out-of-band-halt') {
    return { ...base, mode: 'halt', mayOpenNewRisk: false, escalateToHuman: false, reason: 'out-of-band halt (the only path that may reach halt)' }
  }
  // 带外以外的一切自动触发：一律封顶 reduce_only。
  const reasons: Record<Exclude<DegradationTrigger, 'out-of-band-halt'>, string> = {
    'market-stale': 'quotes are stale: may close, may not open',
    'venue-error': 'venue rejected or is unavailable: reduce only until a clean snapshot',
    'model-api-down': 'model API unavailable: no new risk decisions',
    'control-plane-unreachable': 'control plane unreachable does NOT invalidate the mandate: degrade to the lower-risk side, keep protective orders',
    'core-restart': 'core restarted: no new risk until reconciliation completes',
    'disk-full': 'disk full: no new risk',
    'clock-drift': 'clock drift detected: no new risk',
    'heartbeat-lost': 'bot heartbeat lost (dead-man condition is our own heartbeat, not the phone being offline)',
  }
  const escalation = (context.reduceOnlyForMs ?? 0) > ESCALATE_AFTER_MS
  return {
    ...base,
    mode: 'reduce_only',
    mayOpenNewRisk: false,
    escalateToHuman: escalation,
    reason: reasons[context.trigger] + (escalation ? ' | reduce_only has lasted beyond the escalation threshold: escalate to a human' : ''),
  }
}

/** 一次快照成功后是否回到 aligned（#24：自愈而非闩锁）。 */
export function recoverOnSnapshot(): { mode: RiskMode; reason: string } {
  return { mode: 'normal', reason: 'fresh snapshot accepted: back to aligned' }
}

/** 启动形态声明（#18 第 4 条：独立 uid 不可用时必须显式声明为开发形态）。 */
export interface StartupForm {
  /** 部署形态：production 要求 uid 分离。 */
  readonly kind: 'production' | 'development'
  /** 权限校验是否可用；不可用即禁止启动（不得降级为无鉴权）。 */
  readonly authCheckAvailable: boolean
  /** 账本与凭据目录是否只对核心 uid 可读写（0600/0700）。 */
  readonly credentialsCoreOnly: boolean
  /** 宿主（agent 进程）是否可能自行下单。 */
  readonly hostMayPlaceOrders: boolean
  /** 三个进程是否跑在独立 uid 下。 */
  readonly separateUids: boolean
}

/** 违反「四条禁止的降级」时抛出——启动阶段 fail-closed，不给"警告后继续"。 */
export class ForbiddenDegradationError extends Error {
  readonly violations: readonly string[]
  constructor(violations: readonly string[]) {
    super('refusing to start: ' + violations.join('; '))
    this.name = 'ForbiddenDegradationError'
    this.violations = violations
  }
}

/**
 * 启动断言：把「四条禁止的降级」变成拒绝启动的条件（§13 #18）。
 * @param form - 本进程声明的形态与三个事实。
 */
export function assertNoForbiddenDegradation(form: StartupForm): void {
  const violations: string[] = []
  if (!form.authCheckAvailable) {
    violations.push('权限校验不可用：禁止降级为无鉴权运行（#18-1）')
  }
  if (form.hostMayPlaceOrders) {
    violations.push('宿主可能自行下单：核心不可达时宿主必须拒绝下单，不得代持下单权（#18-2）')
  }
  if (!form.credentialsCoreOnly) {
    violations.push('凭据不在核心侧独占：凭据只住核心（0600/0700），不得复制到宿主或 edge（#18-3）')
  }
  if (form.kind === 'production' && !form.separateUids) {
    violations.push('生产形态但未用独立 uid：独立 uid 不可用时必须显式声明为开发形态（kind: development），不得默认降级（#18-4）')
  }
  if (violations.length > 0) throw new ForbiddenDegradationError(violations)
}

/** 恢复连接时必须产出的 gap report（#19）。 */
export interface GapReport {
  readonly disconnectedMs: number
  readonly missedTriggers: readonly string[]
  readonly rejectedIntents: readonly string[]
  readonly degradationActions: readonly string[]
  readonly positionChanges: readonly { symbol: string; from: number; to: number }[]
}

export interface GapInputs {
  readonly disconnectedFromMs: number
  readonly reconnectedAtMs: number
  readonly missedTriggers: readonly string[]
  readonly rejectedIntents: readonly string[]
  readonly degradationActions: readonly string[]
  readonly positionsBefore: Readonly<Record<string, number>>
  readonly positionsAfter: Readonly<Record<string, number>>
}

/**
 * 生成 gap report。断连期间的持仓变化按并集逐标的比对——只报变化的，不报全量，
 * 这样人一眼能看到"断连期间发生了什么"而不是翻一整张持仓表。
 * @param inputs - 断连窗口与期间记录。
 */
export function buildGapReport(inputs: GapInputs): GapReport {
  const symbols = new Set([...Object.keys(inputs.positionsBefore), ...Object.keys(inputs.positionsAfter)])
  const positionChanges: { symbol: string; from: number; to: number }[] = []
  for (const symbol of symbols) {
    const from = inputs.positionsBefore[symbol] ?? 0
    const to = inputs.positionsAfter[symbol] ?? 0
    if (from !== to) positionChanges.push({ symbol, from, to })
  }
  positionChanges.sort((left, right) => left.symbol.localeCompare(right.symbol))
  return {
    disconnectedMs: Math.max(0, inputs.reconnectedAtMs - inputs.disconnectedFromMs),
    missedTriggers: [...inputs.missedTriggers],
    rejectedIntents: [...inputs.rejectedIntents],
    degradationActions: [...inputs.degradationActions],
    positionChanges,
  }
}

/**
 * 核心侧的风险判定：每次下单前重新读 kill 状态（edge 写、核心读，中间没有缓存）。
 * halt / paused / killed 任一为真 ⇒ 不许新增风险；halt 只可能来自带外（#25）。
 * @param killStatePath - edge 维护的原子状态文件。
 */
export function gateNewRisk(killStatePath: string): { allowed: boolean; state: KillState; reason: string } {
  const state = readKillState(killStatePath)
  if (state.killed) return { allowed: false, state, reason: 'core is halted by an out-of-band kill' }
  if (state.paused) return { allowed: false, state, reason: 'core is paused' }
  return { allowed: true, state, reason: 'no kill or pause flag' }
}
