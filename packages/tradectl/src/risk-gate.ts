/**
 * RiskGate：唯一受限状态机（P3 步骤 2）。
 *
 * 两套**不得相交**的词汇，各管一侧：
 *   - 价格侧 alignment ∈ {aligned, unaligned, stale}（这只标的的价格可不可信）
 *   - desk 侧 level ∈ {normal, caution, reduce_only, halt}（整个 desk 的档位）
 * 判定取合取：openRiskAllowed = (level ∈ {normal, caution}) && (alignment === 'aligned')。
 *
 * **为什么必须两套词汇**：如果标的级的问题也写进 level，那么单个标的的行情抖动就能
 * 把整个 desk 拉下来（单标的 DoS 整个 desk）。分开之后，标的级事件只改该标的的
 * alignment，desk 档位只由 desk 级事件改——这条不变量被写成一个可机检断言：
 *
 *     ∀ 标的级事件 e：level_after(e) == level_before(e)
 *
 * 本模块把它落在两处：reducer 的实现（symbol 分支不碰 level）与测试里的穷举断言
 * （所有标的级事件 × 所有 desk 档位）。断言随 pnpm -r test 进 CI。
 *
 * halt 在自动路径上**永不可达**（§13 #25）：reducer 里唯一能产出 halt 的事件是
 * out-of-band-halt。而 halt 的前提是保护性订单已存在于 venue 原生条件单/OCO——
 * venue 没有这个能力时，halt 必须降级为 reduce_only，并把这一点记为接入准入条件。
 *
 * @module @dshtrading/tractl/risk-gate
 */
import type { KillState } from './edge.ts'

/** 价格侧词汇（只描述一只标的的价格可不可信）。 */
export const PRICE_ALIGNMENTS = ['aligned', 'unaligned', 'stale'] as const
export type Alignment = (typeof PRICE_ALIGNMENTS)[number]

/** desk 侧词汇（只描述整个 desk 的档位）。 */
export const DESK_LEVELS = ['normal', 'caution', 'reduce_only', 'halt'] as const
export type DeskLevel = (typeof DESK_LEVELS)[number]

/** 两套词汇不相交——启动即断言（写错词汇表是最容易发生的静默事故）。 */
export function assertVocabulariesDisjoint(): void {
  const overlap = (PRICE_ALIGNMENTS as readonly string[]).filter((word) => (DESK_LEVELS as readonly string[]).includes(word))
  if (overlap.length > 0) {
    throw new Error('price and desk vocabularies must not overlap, found: ' + overlap.join(', '))
  }
}

/**
 * 连续禁开新仓超过这个时长必须升级到人（§13 #24）。**这是该阈值的唯一家**：
 * degradation.ts 从 2026-10-01 起改为引用这里（此前两处各定义一份，typecheck 的
 * 重复导出把它抓了出来——一个事实只能有一个家）。
 */
export const ESCALATE_AFTER_MS = 10 * 60 * 1000

/** 标的的临时淘汰时长（显式淘汰策略：淘汰有期限，不是永久拉黑）。 */
export const ELIMINATION_MS = 30 * 60 * 1000

/** 一只标的的价格侧状态。 */
export interface SymbolRisk {
  readonly alignment: Alignment
  /** 当前 alignment 的起始时间（用来算"连续多久"）。 */
  readonly sinceMs: number
  /** 淘汰到期时间；未淘汰为 undefined。 */
  readonly eliminatedUntilMs?: number | undefined
}

/** desk 的完整风险状态（纯数据，reducer 的输入输出）。 */
export interface RiskState {
  readonly level: DeskLevel
  /** level 的起始时间（用来算连续禁开新仓时长）。 */
  readonly levelSinceMs: number
  /** 是否由带外触发进入 halt（自动路径永远不会把它置为 true）。 */
  readonly haltFromOutOfBand: boolean
  readonly symbols: Readonly<Record<string, SymbolRisk>>
}

/** 建一个全新的 desk 状态（normal）。 */
export function initialRiskState(atMs: number): RiskState {
  return { level: 'normal', levelSinceMs: atMs, haltFromOutOfBand: false, symbols: {} }
}

/** 事件：每一条都显式标出作用域（symbol 还是 desk）——作用域是 reducer 的分岔依据。 */
export type RiskEvent =
  | { readonly scope: 'symbol'; readonly kind: 'alignment'; readonly symbol: string; readonly alignment: Alignment; readonly atMs: number }
  | { readonly scope: 'symbol'; readonly kind: 'eliminate'; readonly symbol: string; readonly atMs: number; readonly reason: string }
  | { readonly scope: 'desk'; readonly kind: 'desk-level'; readonly level: Exclude<DeskLevel, 'halt'>; readonly atMs: number; readonly reason: string }
  | { readonly scope: 'desk'; readonly kind: 'out-of-band-halt'; readonly atMs: number; readonly reason: string }
  | { readonly scope: 'desk'; readonly kind: 'out-of-band-resume'; readonly atMs: number; readonly reason: string }

/** 一次转移的结果（新状态 + 是否要升级到人）。 */
export interface TransitionResult {
  readonly state: RiskState
  readonly escalateToHuman: boolean
  readonly note: string
}

/** venue 是否具备原生条件单/OCO——halt 的前提（§13 #25）。 */
export interface RiskGateOptions {
  readonly protectiveOrdersAtVenue: boolean
}

function symbolOf(state: RiskState, symbol: string): SymbolRisk {
  return state.symbols[symbol] ?? { alignment: 'aligned', sinceMs: 0 }
}

/**
 * 纯 reducer：吃一个事件，吐新状态。作用域决定它只可能改哪一半状态。
 * @param state - 当前状态。
 * @param event - 事件（带 scope）。
 * @param options - venue 保护能力（决定 halt 能否成立）。
 */
export function applyRiskEvent(state: RiskState, event: RiskEvent, options: RiskGateOptions): TransitionResult {
  if (event.scope === 'symbol') {
    // 标的级分支**不碰 level**（这就是可机检断言在实现里的落点）。
    const current = symbolOf(state, event.symbol)
    if (event.kind === 'alignment') {
      return {
        state: {
          ...state,
          symbols: {
            ...state.symbols,
            [event.symbol]: {
              alignment: event.alignment,
              sinceMs: current.alignment === event.alignment ? current.sinceMs : event.atMs,
              ...(current.eliminatedUntilMs === undefined ? {} : { eliminatedUntilMs: current.eliminatedUntilMs }),
            },
          },
        },
        escalateToHuman: false,
        note: event.symbol + ' alignment -> ' + event.alignment,
      }
    }
    return {
      state: {
        ...state,
        symbols: { ...state.symbols, [event.symbol]: { ...current, eliminatedUntilMs: event.atMs + ELIMINATION_MS } },
      },
      escalateToHuman: false,
      note: event.symbol + ' eliminated until ' + String(event.atMs + ELIMINATION_MS) + ' (' + event.reason + ')',
    }
  }
  if (event.kind === 'out-of-band-halt') {
    if (!options.protectiveOrdersAtVenue) {
      // 接入准入条件未满足：halt 降级为 reduce_only（并把原因写进 note，供部署侧记录）。
      return {
        state: { ...state, level: 'reduce_only', levelSinceMs: event.atMs, haltFromOutOfBand: false },
        escalateToHuman: true,
        note: 'halt requested out-of-band but this venue has no native protective orders/OCO: degraded to reduce_only (venue admission condition unmet)',
      }
    }
    return {
      state: { ...state, level: 'halt', levelSinceMs: event.atMs, haltFromOutOfBand: true },
      escalateToHuman: false,
      note: 'halt from out-of-band request (' + event.reason + ')',
    }
  }
  if (event.kind === 'out-of-band-resume') {
    return {
      state: { ...state, level: 'normal', levelSinceMs: event.atMs, haltFromOutOfBand: false },
      escalateToHuman: false,
      note: 'resumed out-of-band',
    }
  }
  return {
    state: { ...state, level: event.level, levelSinceMs: state.level === event.level ? state.levelSinceMs : event.atMs, haltFromOutOfBand: false },
    escalateToHuman: false,
    note: 'desk level -> ' + event.level + ' (' + event.reason + ')',
  }
}

/** 某只标的此刻能否开新仓（合取判定）。 */
export function openRiskAllowedFor(state: RiskState, symbol: string, atMs: number): { allowed: boolean; reason: string } {
  const symbolRisk = symbolOf(state, symbol)
  if (state.level === 'halt') return { allowed: false, reason: 'desk level is halt' }
  if (state.level === 'reduce_only') return { allowed: false, reason: 'desk level is reduce_only' }
  if (symbolRisk.eliminatedUntilMs !== undefined && atMs < symbolRisk.eliminatedUntilMs) {
    return { allowed: false, reason: symbol + ' is eliminated until ' + String(symbolRisk.eliminatedUntilMs) }
  }
  if (symbolRisk.alignment !== 'aligned') {
    return { allowed: false, reason: symbol + ' price alignment is ' + symbolRisk.alignment }
  }
  return { allowed: true, reason: 'desk level ' + state.level + ' and ' + symbol + ' is aligned' }
}

/** desk 是否应该升级到人（连续禁开新仓超过阈值）。 */
export function shouldEscalate(state: RiskState, atMs: number): boolean {
  if (state.level === 'normal' || state.level === 'caution') return false
  return atMs - state.levelSinceMs > ESCALATE_AFTER_MS
}

/**
 * 显式淘汰策略：desk 级预算/热度触顶时，淘汰**肇事标的**而不是把整个 desk 关掉。
 * 返回淘汰事件——把它喂给 applyRiskEvent，desk 档位保持不变（单标的不得 DoS 整个 desk）。
 * @param symbol - 肇事标的。
 * @param reason - 为什么淘汰（人读）。
 * @param atMs - 注入时钟。
 */
export function eliminationPolicy(symbol: string, reason: string, atMs: number): RiskEvent {
  return { scope: 'symbol', kind: 'eliminate', symbol, atMs, reason }
}

/**
 * 把 edge 的带外 kill 状态接进风险判定（P2 的 kill → P3 的 halt，
 * 前提同样是 venue 有原生保护）。
 * @param state - 当前状态。
 * @param kill - edge 维护的原子 kill 状态。
 * @param atMs - 注入时钟。
 * @param options - venue 保护能力。
 */
export function applyKillState(state: RiskState, kill: KillState, atMs: number, options: RiskGateOptions): TransitionResult {
  if (!kill.killed) return { state, escalateToHuman: false, note: 'no kill flag' }
  return applyRiskEvent(state, { scope: 'desk', kind: 'out-of-band-halt', atMs, reason: 'edge kill by ' + kill.reason }, options)
}
