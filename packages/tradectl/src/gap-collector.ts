/**
 * gap report 收集器（P5 步骤 1 的第二根线：**恢复连接必须产出 gap report**）。
 *
 * 为什么不是"直接调 buildGapReport"：那个函数要四类输入，而**只有一类有数据源**。
 * 本模块只说真话：能从库里取到的就取，取不到的**逐条点名**（%%missingInputs%%），
 * 而不是用空数组冒充"期间什么都没发生" —— 后者是最危险的谎。
 *
 * 数据源现状（2026-10-01 实测）：
 *   - 错过的触发 ✅ %%occurrences%% 表有 %%missed%% 与 %%due_at_ms%%（orders 库）；
 *   - 被拒意图 ⚠️ %%intents%% 表有 %%state%%（可数条数），**但没有理由列** ⇒ 理由分布取不到；
 *   - 降级动作 ⚠️ journal 里目前**没有**降级事件的写入点（只有 shadow.decision 与 reconcile.*）；
 *   - 持仓变化 ⚠️ %%positions%% 只有当前值，**没有历史** ⇒ 只能拿到"之后"，拿不到"之前"。
 *
 * @module @dshtrading/tractl/gap-collector
 */
import type { DatabaseSync } from 'node:sqlite'
import { buildGapReport, type GapReport } from './degradation.ts'

export interface GapCollectorOptions {
  /** orders 库（intents / positions / occurrences）。 */
  readonly orders: DatabaseSync
  /** audit 库（journal）。 */
  readonly audit: DatabaseSync
}

export interface GapWindow {
  readonly disconnectedFromMs: number
  readonly reconnectedAtMs: number
}

export interface GapCollection {
  readonly report: GapReport
  /** 取不到的输入（逐条点名；空数组 = 四类齐全）。 */
  readonly missingInputs: readonly string[]
}

/**
 * 收集断连窗口的 gap report。
 * @param options - 两个库。
 * @param window - 断连起止（核心时钟）。
 */
export function collectGapReport(options: GapCollectorOptions, window: GapWindow): GapCollection {
  const missingInputs: string[] = []

  // ① 错过的触发：occurrences 里 missed=1 且到点落在窗口内的
  const missedRows = options.orders
    .prepare('SELECT schedule_id, due_at_ms FROM occurrences WHERE missed = 1 AND due_at_ms >= ? AND due_at_ms <= ? ORDER BY due_at_ms')
    .all(window.disconnectedFromMs, window.reconnectedAtMs) as { schedule_id: string; due_at_ms: number }[]
  const missedTriggers = missedRows.map((row) => row.schedule_id + '@' + String(row.due_at_ms))

  // ② 被拒意图：有 reason 列就带理由（desk-records 的迁移会补上），没有则如实说明只能给条数
  const intentColumns = options.orders.prepare('PRAGMA table_info(intents)').all() as { name: string }[]
  const hasReasonColumn = intentColumns.some((column) => column.name === 'reason')
  const rejectedRows = (hasReasonColumn
    ? options.orders.prepare("SELECT intent_id, reason FROM intents WHERE state = 'rejected' AND updated_ms >= ? AND updated_ms <= ? ORDER BY updated_ms")
    : options.orders.prepare("SELECT intent_id, NULL AS reason FROM intents WHERE state = 'rejected' AND updated_ms >= ? AND updated_ms <= ? ORDER BY updated_ms")
  ).all(window.disconnectedFromMs, window.reconnectedAtMs) as { intent_id: string; reason: string | null }[]
  const rejectedIntents = rejectedRows.map((row) => (row.reason === null || row.reason === '' ? row.intent_id : row.intent_id + ':' + row.reason))
  if (!hasReasonColumn && rejectedIntents.length > 0) {
    missingInputs.push('被拒意图的理由：intents 表没有 reason 列（跑 migrateDeskRecords 可补），只能给出条数（' + String(rejectedIntents.length) + ' 条）')
  }

  // ③ 降级动作：journal 里目前没有降级事件的写入点
  const degradationRows = options.audit
    .prepare("SELECT seq FROM journal WHERE kind LIKE 'degradation%' AND at_ms >= ? AND at_ms <= ? ORDER BY seq")
    .all(window.disconnectedFromMs, window.reconnectedAtMs) as { seq: number }[]
  const degradationActions = degradationRows.map((row) => String(row.seq))
  if (degradationActions.length === 0) {
    missingInputs.push('降级动作：本窗口内 journal 没有 degradation* 事件（写入点是 recordDegradation；若期间确实没有档位变化，这条会一直在）')
  }

  // ④ 持仓：**从 journal 的 position.change 事件重建**（desk-records 的 recordPositionChange 写的）
  // 取法：窗口**开始前**每个标的的最后一条 ⇒ "之前"；窗口**结束前**每个标的的最后一条 ⇒ "之后"。
  // 同时读 positions 当前值兜底（journal 被裁剪过时至少能拿到"之后"）。
  const positionEvents = options.audit
    .prepare("SELECT at_ms, payload FROM journal WHERE kind = 'position.change' AND at_ms <= ? ORDER BY seq")
    .all(window.reconnectedAtMs) as { at_ms: number; payload: string }[]
  const positionsBefore: Record<string, number> = {}
  const positionsAfter: Record<string, number> = {}
  let beforeEvents = 0
  for (const event of positionEvents) {
    let parsed: { symbol?: unknown; to?: unknown }
    try {
      parsed = JSON.parse(event.payload) as { symbol?: unknown; to?: unknown }
    } catch {
      continue
    }
    if (typeof parsed.symbol !== 'string' || typeof parsed.to !== 'number') continue
    // 窗口开始前的事件只影响"之前"；窗口内（含结束）的事件同时更新两者
    if (event.at_ms <= window.disconnectedFromMs) {
      positionsBefore[parsed.symbol] = parsed.to
      beforeEvents += 1
    }
    positionsAfter[parsed.symbol] = parsed.to
  }
  // 兜底：journal 里没有的标的，用 positions 当前值当"之后"
  const currentPositions = options.orders.prepare('SELECT symbol, quantity FROM positions').all() as { symbol: string; quantity: number }[]
  let fallbackUsed = 0
  for (const row of currentPositions) {
    if (positionsAfter[row.symbol] === undefined) {
      positionsAfter[row.symbol] = row.quantity
      fallbackUsed += 1
    }
  }
  if (beforeEvents === 0 && Object.keys(positionsAfter).length > 0) {
    missingInputs.push('断连前的持仓：journal 里没有窗口之前的 position.change 事件（可能被裁剪，或写入者未接线）⇒ positionsBefore 为空、持仓变化只反映窗口内')
  }
  if (fallbackUsed > 0) {
    missingInputs.push('部分标的的"之后"持仓取自 positions 当前值（journal 无记录），与断连时刻可能有偏差（' + String(fallbackUsed) + ' 个标的）')
  }

  const report = buildGapReport({
    disconnectedFromMs: window.disconnectedFromMs,
    reconnectedAtMs: window.reconnectedAtMs,
    missedTriggers,
    rejectedIntents,
    degradationActions,
    positionsBefore,
    positionsAfter,
  })

  return { report, missingInputs }
}
