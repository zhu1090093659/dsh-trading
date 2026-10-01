/**
 * 触发器与扇出（P3 步骤 3）：核心自建的持久 timer wheel。
 *
 * **不依赖官方 schedule/webhook**：触发是执行核自己的事——它必须与账本同生共死，
 * 而不是寄居在一个可以被单独重启/升级的宿主插件里。
 *
 * 四条约束（卡片原文）与它们的落点：
 *   1. **持久 + 落盘 occurrence**：调度表与"发生过的触发"都写在 orders.db（synchronous
 *      = FULL，与钱同一个耐久档）。理由：错过的触发是风险相关事实，静默丢掉它就是
 *      让"该减的风险没减"。
 *   2. **扇出必须节流**：followup 每次都是一条独立普通 turn（官方语义），一个窗口里
 *      扇 N 条等于把 desk 会话刷爆。节流器把窗口内的多条**合并成一条**并带上原始条数，
 *      既不刷爆也不丢（丢才是问题，合并不是）。
 *   3. **重启期间错过的触发不得静默消失，且错过只能减风险**：错过的一律以 missed 标出，
 *      并被钉成 reduce_only 语义——错过的开仓信号不能补执行（价格早就变了），
 *      但错过的减仓/风控信号必须补上。
 *   4. **desk 会话可换代丢弃，权威态在执行核账本**：wheel 不持有会话状态，换代只是换一个
 *      sessionId；occurrence 落在账本里，所以新会话能从账本继续。
 *
 * @module @dshtrading/tractl/triggers
 */
import type { DatabaseSync } from 'node:sqlite'

/** 一条调度（周期或单次）。 */
export interface Schedule {
  readonly id: string
  /** 触发间隔（毫秒）；一次性调度用 atMs + intervalMs = null。 */
  readonly intervalMs: number | null
  /** 一次性调度的绝对时间。 */
  readonly atMs: number | null
  /** 下一次应当触发的时间（持久化，重启后据此补算错过）。 */
  readonly nextAtMs: number
  readonly enabled: boolean
  /** 触发时交给 desk 的意图类型（人读 + 扇出分类用）。 */
  readonly kind: string
}

/** 一次"发生过的触发"。 */
export interface Occurrence {
  readonly scheduleId: string
  readonly dueAtMs: number
  readonly missed: boolean
  readonly kind: string
}

/** 扇出器（注入 followup 与时钟）。 */
export interface FanoutPort {
  (input: { sessionId: string; text: string; occurrences: readonly Occurrence[]; reduceOnly: boolean }): Promise<void>
}

export interface FanoutOptions {
  readonly followup: FanoutPort
  readonly now: () => number
  /** 节流窗口与窗口内最多扇几条。 */
  readonly windowMs: number
  readonly maxPerWindow: number
}

/** 扇出结果（给调用方与测试看：扇了几条、合并了几条、失败几条）。 */
export interface FanoutResult {
  readonly sent: number
  readonly coalesced: number
  readonly failed: number
}

/** 建表：调度表 + occurrence 表（幂等）。 */
export function migrateTriggers(db: DatabaseSync): void {
  db.exec([
    'CREATE TABLE IF NOT EXISTS schedules (',
    '  id TEXT PRIMARY KEY,',
    '  interval_ms INTEGER,',
    '  at_ms INTEGER,',
    '  next_at_ms INTEGER NOT NULL,',
    '  enabled INTEGER NOT NULL,',
    '  kind TEXT NOT NULL',
    ')',
  ].join(String.fromCharCode(10)))
  // occurrence 的主键是 (scheduleId, dueAtMs)：同一个点重复触发是幂等失败，不是新事件。
  db.exec([
    'CREATE TABLE IF NOT EXISTS occurrences (',
    '  schedule_id TEXT NOT NULL,',
    '  due_at_ms INTEGER NOT NULL,',
    '  fired_at_ms INTEGER,',
    '  missed INTEGER NOT NULL,',
    '  kind TEXT NOT NULL,',
    '  status TEXT NOT NULL,',
    '  attempts INTEGER NOT NULL DEFAULT 0,',
    '  PRIMARY KEY (schedule_id, due_at_ms)',
    ')',
  ].join(String.fromCharCode(10)))
}

/** 加一条调度。 */
export function addSchedule(db: DatabaseSync, schedule: Schedule): void {
  db.prepare(
    'INSERT OR REPLACE INTO schedules (id, interval_ms, at_ms, next_at_ms, enabled, kind) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(schedule.id, schedule.intervalMs, schedule.atMs, schedule.nextAtMs, schedule.enabled ? 1 : 0, schedule.kind)
}

interface ScheduleRow {
  id: string
  interval_ms: number | null
  at_ms: number | null
  next_at_ms: number
  enabled: number
  kind: string
}

function readSchedules(db: DatabaseSync): Schedule[] {
  const rows = db.prepare('SELECT id, interval_ms, at_ms, next_at_ms, enabled, kind FROM schedules').all() as unknown as ScheduleRow[]
  return rows.map((row) => ({
    id: row.id,
    intervalMs: row.interval_ms === null ? null : Number(row.interval_ms),
    atMs: row.at_ms === null ? null : Number(row.at_ms),
    nextAtMs: Number(row.next_at_ms),
    enabled: row.enabled === 1,
    kind: row.kind,
  }))
}

/**
 * 到点计算（纯读取）：返回所有应触发但还没触发过的 occurrence。
 * 重启后的第一次调用就是"补算错过"——所以它是**唯一**的触发入口，没有第二条捷径。
 * @param db - 账本库（orders.db）。
 * @param nowMs - 注入时钟。
 */
export function dueOccurrences(db: DatabaseSync, nowMs: number): Occurrence[] {
  const due: Occurrence[] = []
  for (const schedule of readSchedules(db)) {
    if (!schedule.enabled) continue
    let cursor = schedule.nextAtMs
    let guard = 0
    while (cursor <= nowMs && guard < 1000) {
      const existing = db
        .prepare('SELECT status FROM occurrences WHERE schedule_id = ? AND due_at_ms = ?')
        .get(schedule.id, cursor) as { status: string } | undefined
      if (existing === undefined) {
        due.push({ scheduleId: schedule.id, dueAtMs: cursor, missed: nowMs > cursor, kind: schedule.kind })
      }
      guard += 1
      if (schedule.intervalMs === null) break
      cursor += schedule.intervalMs
    }
  }
  return due
}

/** 把 occurrence 记为"已触发"（幂等：主键冲突即忽略）。 */
export function markFired(db: DatabaseSync, occurrence: Occurrence, firedAtMs: number, status: 'fired' | 'failed'): void {
  db.prepare(
    'INSERT INTO occurrences (schedule_id, due_at_ms, fired_at_ms, missed, kind, status, attempts) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(schedule_id, due_at_ms) DO UPDATE SET status = excluded.status, attempts = occurrences.attempts + 1, fired_at_ms = excluded.fired_at_ms',
  ).run(occurrence.scheduleId, occurrence.dueAtMs, firedAtMs, occurrence.missed ? 1 : 0, occurrence.kind, status)
}

/** 把调度的 nextAt 推到 dueAt 之后（一次性调度则禁用自己）。 */
export function advanceSchedule(db: DatabaseSync, scheduleId: string, dueAtMs: number, nowMs: number): void {
  const row = db.prepare('SELECT interval_ms, at_ms FROM schedules WHERE id = ?').get(scheduleId) as
    | { interval_ms: number | null; at_ms: number | null }
    | undefined
  if (row === undefined) return
  if (row.interval_ms === null) {
    db.prepare('UPDATE schedules SET enabled = 0, next_at_ms = ? WHERE id = ?').run(dueAtMs, scheduleId)
    return
  }
  // 追赶：把 nextAt 推到第一个大于 now 的点（不补发每一个中间点——那是 dueOccurrences 的职责）
  const interval = Number(row.interval_ms)
  let next = Number(dueAtMs) + interval
  while (next <= nowMs) next += interval
  db.prepare('UPDATE schedules SET next_at_ms = ? WHERE id = ?').run(next, scheduleId)
}

/**
 * 节流扇出：窗口内最多扇 maxPerWindow 条；窗口内多出来的**合并成一条**并带原始条数。
 * 合并是"不丢"的：调用方拿到的是同一次 followup 里更长的 occurrences 列表。
 * @param options - followup、时钟与窗口参数。
 */
export function createThrottledFanout(options: FanoutOptions): {
  send(sessionId: string, occurrences: readonly Occurrence[]): Promise<FanoutResult>
} {
  const windows = new Map<string, { windowStartMs: number; sentInWindow: number }>()
  return {
    async send(sessionId, occurrences) {
      if (occurrences.length === 0) return { sent: 0, coalesced: 0, failed: 0 }
      const nowMs = options.now()
      const state = windows.get(sessionId) ?? { windowStartMs: nowMs, sentInWindow: 0 }
      if (nowMs - state.windowStartMs >= options.windowMs) {
        state.windowStartMs = nowMs
        state.sentInWindow = 0
      }
      // 错过的一律按 reduce-only 扇出（错过只能减风险）。
      const reduceOnly = occurrences.every((occurrence) => occurrence.missed) || occurrences.some((occurrence) => occurrence.missed)
      const room = Math.max(1, options.maxPerWindow - state.sentInWindow)
      const batch = room >= occurrences.length ? occurrences : occurrences.slice(0, room)
      const merged = occurrences.length - batch.length
      const text = describe(occurrences, merged)
      windows.set(sessionId, { windowStartMs: state.windowStartMs, sentInWindow: state.sentInWindow + 1 })
      try {
        await options.followup({ sessionId, text, occurrences, reduceOnly })
        return { sent: 1, coalesced: merged, failed: 0 }
      } catch {
        // 扇出失败不吞：调用方据此把 occurrence 记 failed 并保留重试机会。
        return { sent: 0, coalesced: merged, failed: 1 }
      }
    },
  }
}

/** 扇出文本：人读的叙述，带条数与"错过"标注。 */
export function describe(occurrences: readonly Occurrence[], merged = 0): string {
  const missed = occurrences.filter((occurrence) => occurrence.missed)
  const parts = [
    'trigger batch: ' + String(occurrences.length) + ' occurrence(s)',
    missed.length > 0 ? String(missed.length) + ' of them were missed while the core was down (risk-reducing only)' : 'none missed',
  ]
  if (merged > 0) parts.push(String(merged) + ' coalesced into this turn by the fanout throttle')
  parts.push('kinds: ' + [...new Set(occurrences.map((occurrence) => occurrence.kind))].join(', '))
  return parts.join(' | ')
}

/** 一次 tick 的结果。 */
export interface TickResult {
  readonly due: number
  readonly fired: number
  readonly failed: number
  readonly reduceOnly: boolean
}

/**
 * 跑一次 tick：算出到点的 occurrence → 扇出（节流）→ 记账 → 推进 nextAt。
 * 顺序有意如此：**先记账后推进**，于是崩在中间最坏是重复扇出一次（幂等由 occurrence
 * 主键与调用方的去重兜住），而不是静默少扇一次。
 * @param db - 账本库。
 * @param sessionId - 当前 desk 会话（换代只影响这里）。
 * @param fanout - 节流扇出器。
 * @param nowMs - 注入时钟。
 */
export async function tick(
  db: DatabaseSync,
  sessionId: string,
  fanout: ReturnType<typeof createThrottledFanout>,
  nowMs: number,
): Promise<TickResult> {
  const due = dueOccurrences(db, nowMs)
  if (due.length === 0) return { due: 0, fired: 0, failed: 0, reduceOnly: false }
  const result = await fanout.send(sessionId, due)
  const reduceOnly = due.some((occurrence) => occurrence.missed)
  for (const occurrence of due) {
    markFired(db, occurrence, nowMs, result.failed > 0 ? 'failed' : 'fired')
    advanceSchedule(db, occurrence.scheduleId, occurrence.dueAtMs, nowMs)
  }
  return { due: due.length, fired: result.sent, failed: result.failed, reduceOnly }
}
