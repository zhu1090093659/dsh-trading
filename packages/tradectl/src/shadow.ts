/**
 * shadow 装置（P3 步骤 5）：agent 正常决策、**零 venue 写**，并把每张决策卡片的
 * provenance 做到"足以重建判定"。
 *
 * 三条判据（卡片原文）与落点：
 *   1. **零 venue 写**：shadow 模式在**结构上**拿不到下单通道——createShadowDesk 根本不
 *      接受 venue 端口参数。不是"约定不要调"，而是"没有可调的东西"。测试里那个假 venue
 *      的存在就是为了证明它一次都没被碰过。
 *   2. **决策卡片**：触发源 → 论点 → 动作 → 结果 → **命中哪条限额**（限额命中必须落在
 *      卡片上，否则事后无法回答"这一单是被哪条额度挡下的"）。
 *   3. **provenance 足以重建判定**：卡片必须带上判定时刻的价格与年龄、持仓/敞口快照版本、
 *      mandate 版本指针、行情世代与对齐状态。rebuildDecision 用这些输入重跑判定，
 *      得到同一结论才算"可重建"；价格超过年龄预算的卡片会被明确标成**不可重建**——
 *      诚实标注比假装能重建重要。
 *
 * @module @dshtrading/tractl/shadow
 */
import type { DatabaseSync } from 'node:sqlite'
import { createJournal, type Journal } from './journal.ts'
import { openRiskAllowedFor, type Alignment, type DeskLevel, type RiskState } from './risk-gate.ts'

/** 判定时刻的证据指针（重建判定的最小输入集）。 */
export interface Provenance {
  /** 判定依据的价格与其年龄。 */
  readonly price: number
  readonly priceAgeMs: number
  /** 持仓/敞口快照的版本号（账本里的单调序号）。 */
  readonly positionSnapshotSeq: number
  /** mandate 版本指针 + 其 canonical 载荷的散列（防止"同一版本号不同内容"）。 */
  readonly mandateVersion: number
  readonly mandateHash: string
  /** 行情世代与对齐状态。 */
  readonly epoch: number | null
  readonly alignment: Alignment
  readonly level: DeskLevel
}

/** 限额名（命中哪条要能说出来）。 */
export type LimitName = 'none' | 'notionalMax' | 'positionNotionalMax' | 'deskNotionalMax' | 'maxOpenOrders' | 'leverageMax' | 'riskGate'

/** 一张决策卡片。 */
export interface DecisionCard {
  readonly atMs: number
  readonly trigger: string
  readonly thesis: string
  readonly action: { readonly kind: 'open' | 'reduce' | 'hold'; readonly symbol: string; readonly quantity: number; readonly notional: number }
  readonly result: 'allowed' | 'blocked' | 'not-applicable'
  readonly limitHit: LimitName
  readonly provenance: Provenance
}

/** 限额检查的输入（判定的确定性部分）。 */
export interface LimitInputs {
  readonly limits: { readonly notionalMax: number; readonly positionNotionalMax: number; readonly deskNotionalMax: number; readonly maxOpenOrders: number; readonly leverageMax: number }
  readonly positionNotional: number
  readonly deskNotional: number
  readonly openOrders: number
  readonly leverage: number
}

/** 纯函数：判定这一单被哪条限额挡下（先到先挡，顺序固定 = 可重建）。 */
export function firstLimitHit(action: DecisionCard['action'], inputs: LimitInputs): LimitName {
  if (action.notional > inputs.limits.notionalMax) return 'notionalMax'
  if (inputs.positionNotional + action.notional > inputs.limits.positionNotionalMax) return 'positionNotionalMax'
  if (inputs.deskNotional + action.notional > inputs.limits.deskNotionalMax) return 'deskNotionalMax'
  if (inputs.openOrders + 1 > inputs.limits.maxOpenOrders) return 'maxOpenOrders'
  if (inputs.leverage > inputs.limits.leverageMax) return 'leverageMax'
  return 'none'
}

export interface ShadowDeskOptions {
  /** 账本库（audit.db）：卡片与判定都落 append-only journal。 */
  readonly db: DatabaseSync
  readonly now: () => number
  readonly limits: LimitInputs['limits']
  /** 价格年龄预算：超了这张卡片就不可重建。 */
  readonly priceAgeBudgetMs: number
}

/** shadow 装置（**没有**任何下单端口参数——结构上零 venue 写）。 */
export interface ShadowDesk {
  decide(input: {
    readonly trigger: string
    readonly thesis: string
    readonly action: DecisionCard['action']
    readonly provenance: Provenance
    readonly risk: RiskState
    readonly limits: LimitInputs
  }): { card: DecisionCard; rebuildable: boolean }
  cards(): readonly DecisionCard[]
  narrative(atMs: number): string
}

function hash(text: string): string {
  // 简易稳定散列：provenance 里只需要"同一 mandate 内容得到同一指针"
  let value = 0
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) % 2_147_483_647
  return 'h' + String(value)
}

/**
 * 建 shadow 装置。**不接受任何 venue 端口**——这是"零 venue 写"的结构保证。
 * @param options - 账本、时钟、限额与价格年龄预算。
 */
export function createShadowDesk(options: ShadowDeskOptions): ShadowDesk {
  const journal: Journal = createJournal(options.db, { now: options.now })
  const cards: DecisionCard[] = []
  return {
    decide(input) {
      const gate = openRiskAllowedFor(input.risk, input.action.symbol, options.now())
      const limitHit: LimitName = input.action.kind === 'open'
        ? (gate.allowed ? firstLimitHit(input.action, input.limits) : 'riskGate')
        : 'none'
      const result: DecisionCard['result'] = input.action.kind === 'hold'
        ? 'not-applicable'
        : limitHit === 'none'
          ? 'allowed'
          : 'blocked'
      const card: DecisionCard = {
        atMs: options.now(),
        trigger: input.trigger,
        thesis: input.thesis,
        action: input.action,
        result,
        limitHit,
        provenance: input.provenance,
      }
      cards.push(card)
      journal.append('shadow.decision', {
        trigger: card.trigger,
        action: card.action,
        result: card.result,
        limitHit: card.limitHit,
        provenance: card.provenance,
      })
      return { card, rebuildable: card.provenance.priceAgeMs <= options.priceAgeBudgetMs }
    },
    cards: () => cards.slice(),
    narrative(atMs) {
      const total = cards.length
      const blocked = cards.filter((card) => card.result === 'blocked')
      const byLimit = new Map<LimitName, number>()
      for (const card of blocked) byLimit.set(card.limitHit, (byLimit.get(card.limitHit) ?? 0) + 1)
      const stale = cards.filter((card) => card.provenance.priceAgeMs > options.priceAgeBudgetMs).length
      const parts = [
        'shadow status at ' + String(atMs) + ': ' + String(total) + ' decision(s), ' + String(blocked.length) + ' blocked',
        'blocked by: ' + (byLimit.size === 0 ? 'nothing' : [...byLimit.entries()].map(([limit, count]) => limit + ' x' + String(count)).join(', ')),
        'cards with stale price provenance (not rebuildable): ' + String(stale),
        'venue writes: 0 (this desk has no order port at all)',
      ]
      return parts.join(' | ')
    },
  }
}

/**
 * 用一个**假 venue 端口**验证"零 venue 写"：把它传给 shadow 装置是做不到的（装置没有
 * 这个参数），所以测试改为记录"装置跑完后端口调用次数"，用 0 来证明。
 */
export function createCountingVenue(): { placeOrder(order: unknown): void; calls: number } {
  return {
    placeOrder() {
      this.calls += 1
    },
    calls: 0,
  }
}

/**
 * 重建判定：用卡片里的 provenance 与给定输入重跑，返回是否与卡片结论一致。
 * 价格超龄的卡片直接判为**不可重建**（不假装）。
 * @param card - 待重建的卡片。
 * @param limits - 重建时的限额输入（应与当时一致；不一致本身就是发现）。
 * @param priceAgeBudgetMs - 年龄预算。
 */
export function rebuildDecision(
  card: DecisionCard,
  limits: LimitInputs,
  priceAgeBudgetMs: number,
): { rebuildable: boolean; reproduced: boolean; detail: string } {
  if (card.provenance.priceAgeMs > priceAgeBudgetMs) {
    return { rebuildable: false, reproduced: false, detail: 'price provenance is older than the age budget: this card cannot be rebuilt' }
  }
  if (card.action.kind === 'hold') {
    return { rebuildable: true, reproduced: card.result === 'not-applicable', detail: 'hold decisions carry no limit' }
  }
  if (card.limitHit === 'riskGate') {
    return { rebuildable: true, reproduced: card.result === 'blocked', detail: 'risk gate blocked it (level/alignment recorded in provenance)' }
  }
  const recomputed = firstLimitHit(card.action, limits)
  return {
    rebuildable: true,
    reproduced: recomputed === card.limitHit,
    detail: recomputed === card.limitHit ? 'limit ' + recomputed + ' reproduced' : 'limit mismatch: card says ' + card.limitHit + ', rebuild says ' + recomputed,
  }
}

/** provenance 的散列（卡片里记 mandate 指针用）。 */
export function provenanceHash(text: string): string {
  return hash(text)
}
