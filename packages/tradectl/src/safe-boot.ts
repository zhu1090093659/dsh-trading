/**
 * safe boot：启动先与 venue 对账，对账完成前**禁止新增风险**（P2 步骤 2）。
 *
 * 三条不许妥协的判据（卡片原文）：
 *   1. **对账权威是 venue，不是本地日志**：本地记着 submitted 只说明我们发过请求，
 *      不说明交易所收到了、更不说明它现在还挂着。所以判定一律以 venue 的回答为准；
 *   2. **submitted-unknown 绝不自动重发**：本地 submitted、venue 查不到 —— 可能是
 *      请求还在路上、也可能是我们记错了。重发等于把「可能已经成交」的仓位翻倍，
 *      所以状态钉在 submitted-unknown 等人处理，不自动做任何动作；
 *   3. **存活挂单默认撤销**：重启后我们已丢失那笔挂单的上下文（谁下的、为什么下），
 *      让它继续挂着就是让一个没人负责的风险敞口活着。默认撤，撤销失败要显式报错。
 *
 * 决策表被写成**纯函数** planReconcile：不碰网络、不碰时钟、不碰数据库，
 * 于是每条分支都能被逐条断言，而不需要把 venue 变成 mock。
 *
 * @module @dshtrading/tradectl/safe-boot
 */
import type { Ledgers } from './db.ts'
import { createJournal, type Journal } from './journal.ts'

/** 本地账本里的一条下单意图（orders.db）。 */
export interface LocalIntent {
  readonly intentId: string
  readonly clientOrderId: string
  readonly symbol: string
  readonly state: 'intent' | 'submitted' | 'submitted-unknown' | 'terminal'
  readonly venueOrderId?: string | undefined
}

/** venue 侧的一条订单（对账权威）。 */
export interface VenueOrder {
  readonly venueOrderId: string
  readonly clientOrderId: string
  readonly symbol: string
  readonly state: 'open' | 'filled' | 'cancelled' | 'rejected'
}

/** 对账输入与产出（纯函数契约）。 */
export interface ReconcilePlan {
  /** intent 阶段、从未提交 ⇒ 回滚（本地标记，venue 侧无痕迹）。 */
  readonly rollbacks: readonly string[]
  /** submitted 但 venue 既不认单也非终态 ⇒ 钉成 submitted-unknown，绝不自动重发。 */
  readonly unknown: readonly string[]
  /** venue 侧仍存活 ⇒ 默认撤销。 */
  readonly cancels: readonly { intentId: string; venueOrderId: string }[]
  /** venue 给了终态 ⇒ 收敛本地状态。 */
  readonly settle: readonly { intentId: string; state: 'terminal'; venueOrderId: string; venueState: VenueOrder['state'] }[]
  /** 本地认为还没提交、venue 却认单 ⇒ 以 venue 为准（本地丢过写）。 */
  readonly adoptions: readonly { intentId: string; venueOrderId: string; venueState: VenueOrder['state'] }[]
}

/**
 * 对账决策表（纯函数）。判定顺序即优先级：先处理 venue 认得的单，再处理认不得的。
 * @param local - 本地意图。
 * @param venue - venue 的权威快照。
 */
export function planReconcile(local: readonly LocalIntent[], venue: readonly VenueOrder[]): ReconcilePlan {
  const byClientId = new Map(venue.map((order) => [order.clientOrderId, order]))
  const rollbacks: string[] = []
  const unknown: string[] = []
  const cancels: { intentId: string; venueOrderId: string }[] = []
  const settle: { intentId: string; state: 'terminal'; venueOrderId: string; venueState: VenueOrder['state'] }[] = []
  const adoptions: { intentId: string; venueOrderId: string; venueState: VenueOrder['state'] }[] = []

  for (const intent of local) {
    const venueOrder = byClientId.get(intent.clientOrderId)
    if (venueOrder === undefined) {
      if (intent.state === 'intent') rollbacks.push(intent.intentId)
      // 本地记 submitted、venue 查不到：既不能回滚（可能已经成交）也不能重发。
      else if (intent.state !== 'terminal') unknown.push(intent.intentId)
      continue
    }
    if (intent.state === 'intent') {
      adoptions.push({ intentId: intent.intentId, venueOrderId: venueOrder.venueOrderId, venueState: venueOrder.state })
      continue
    }
    if (venueOrder.state === 'open') {
      cancels.push({ intentId: intent.intentId, venueOrderId: venueOrder.venueOrderId })
      continue
    }
    settle.push({ intentId: intent.intentId, state: 'terminal', venueOrderId: venueOrder.venueOrderId, venueState: venueOrder.state })
  }
  return { rollbacks, unknown, cancels, settle, adoptions }
}

/** 风险闸门：对账完成前一律关闭，尝试越闸即刻抛错（fail-closed）。 */
export interface RiskGate {
  readonly open: boolean
  /** 越闸即抛；返回 undefined 表示放行。 */
  assertAllowed(action: string): void
  /** 只有 safeBoot 成功完成后才由内部调用。 */
  admit(): void
}

/** 造一个关闭态的风险闸门。 */
export function createRiskGate(): RiskGate {
  let open = false
  return {
    get open() {
      return open
    },
    assertAllowed(action: string) {
      if (!open) throw new Error('risk not allowed before venue reconciliation completes: ' + action)
    },
    admit() {
      open = true
    },
  }
}

/** safeBoot 的外部效应（对账权威 + 撤销动作），都是注入的。 */
export interface ReconcileDeps {
  /** 读 venue 的权威快照。 */
  venueOrders(): Promise<readonly VenueOrder[]>
  /** 撤销一笔存活挂单；失败必须抛（不许吞）。 */
  cancelOrder(venueOrderId: string): Promise<void>
}

/** safeBoot 的结果（对账计划 + 实际做了哪些动作）。 */
export interface SafeBootResult {
  readonly plan: ReconcilePlan
  readonly applied: {
    readonly rolledBack: number
    readonly markedUnknown: number
    readonly cancelled: number
    readonly settled: number
    readonly adopted: number
  }
  readonly gate: RiskGate
}

function readLocalIntents(ledgers: Ledgers): LocalIntent[] {
  const rows = ledgers.orders
    .prepare('SELECT intent_id, client_order_id, symbol, state, venue_order_id FROM intents')
    .all() as unknown as {
    intent_id: string
    client_order_id: string
    symbol: string
    state: LocalIntent['state']
    venue_order_id: string | null
  }[]
  return rows.map((row) => ({
    intentId: row.intent_id,
    clientOrderId: row.client_order_id,
    symbol: row.symbol,
    state: row.state,
    venueOrderId: row.venue_order_id ?? undefined,
  }))
}

/**
 * 执行 safe boot：读本地意图 → 读 venue 权威快照 → 按决策表落账 → 撤存活挂单 →
 * 全部成功后才开门。任一步失败都不开门（fail-closed），并把失败原样抛出。
 * @param ledgers - 已打开的账本。
 * @param deps - 对账权威与撤销动作。
 * @param options - now 注入时钟；journal 复用同一个 audit 库。
 */
export async function safeBoot(
  ledgers: Ledgers,
  deps: ReconcileDeps,
  options: { now: () => number; journal?: Journal },
): Promise<SafeBootResult> {
  const journal = options.journal ?? createJournal(ledgers.audit, { now: options.now })
  const gate = createRiskGate()
  const local = readLocalIntents(ledgers)
  const venue = await deps.venueOrders()
  const plan = planReconcile(local, venue)
  const atMs = options.now()
  const stamp = (intentId: string, state: LocalIntent['state'], venueOrderId?: string): void => {
    ledgers.orders
      .prepare('UPDATE intents SET state = ?, venue_order_id = COALESCE(?, venue_order_id), updated_ms = ? WHERE intent_id = ?')
      .run(state, venueOrderId ?? null, atMs, intentId)
  }
  for (const intentId of plan.rollbacks) {
    stamp(intentId, 'terminal')
    journal.append('reconcile.rollback', { intentId })
  }
  for (const intentId of plan.unknown) {
    stamp(intentId, 'submitted-unknown')
    journal.append('reconcile.submitted-unknown', { intentId })
  }
  for (const entry of plan.adoptions) {
    stamp(entry.intentId, entry.venueState === 'open' ? 'submitted' : 'terminal', entry.venueOrderId)
    journal.append('reconcile.adopt', { intentId: entry.intentId, venueOrderId: entry.venueOrderId, venueState: entry.venueState })
  }
  for (const entry of plan.settle) {
    stamp(entry.intentId, 'terminal', entry.venueOrderId)
    journal.append('reconcile.settle', { intentId: entry.intentId, venueState: entry.venueState })
  }
  let cancelled = 0
  for (const entry of plan.cancels) {
    await deps.cancelOrder(entry.venueOrderId)
    stamp(entry.intentId, 'terminal', entry.venueOrderId)
    journal.append('reconcile.cancel', { intentId: entry.intentId, venueOrderId: entry.venueOrderId })
    cancelled += 1
  }
  journal.append('reconcile.done', {
    rolledBack: plan.rollbacks.length,
    unknown: plan.unknown.length,
    cancelled,
    settled: plan.settle.length,
    adopted: plan.adoptions.length,
  })
  gate.admit()
  return {
    plan,
    applied: {
      rolledBack: plan.rollbacks.length,
      markedUnknown: plan.unknown.length,
      cancelled,
      settled: plan.settle.length,
      adopted: plan.adoptions.length,
    },
    gate,
  }
}
