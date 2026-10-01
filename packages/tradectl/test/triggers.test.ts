/**
 * 触发器与扇出行为测试（P3 步骤 3）：真 node:sqlite + 注入时钟 + 契约假 followup，
 * 无 mock 无 sleep。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers, type Ledgers } from '../src/db.ts'
import {
  addSchedule,
  advanceSchedule,
  createThrottledFanout,
  describe as describeBatch,
  dueOccurrences,
  markFired,
  migrateTriggers,
  tick,
  type Occurrence,
} from '../src/triggers.ts'

const dirs: string[] = []
const ledgers: Ledgers[] = []
afterEach(() => {
  for (const opened of ledgers.splice(0)) opened.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const T0 = 1_700_000_000_000

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tradectl-triggers-'))
  dirs.push(dir)
  const opened = openLedgers(dir)
  ledgers.push(opened)
  migrateTriggers(opened.orders)
  return opened
}

/** 契约假 followup：如实记录每次扇出，可注入失败。 */
function fakeFollowup(options: { failTimes?: number } = {}) {
  const calls: { sessionId: string; text: string; occurrences: readonly Occurrence[]; reduceOnly: boolean }[] = []
  let failures = options.failTimes ?? 0
  const followup = async (input: { sessionId: string; text: string; occurrences: readonly Occurrence[]; reduceOnly: boolean }) => {
    calls.push(input)
    if (failures > 0) {
      failures -= 1
      throw new Error('desk session unavailable')
    }
  }
  return { calls, followup }
}

describe('timer wheel 调度', () => {
  it('管理员：未到点不触发；到点触发一次；推进 nextAt 后下一个周期再触发', async () => {
    // Given 一条每 60 秒的调度，起点 T0
    const db = fixture().orders
    addSchedule(db, { id: 's1', intervalMs: 60_000, atMs: null, nextAtMs: T0 + 60_000, enabled: true, kind: 'rebalance' })
    const { calls, followup } = fakeFollowup()
    const fanout = createThrottledFanout({ followup, now: () => T0, windowMs: 1000, maxPerWindow: 5 })
    // When 在 T0（未到点）与 T0+60s（到点）各 tick 一次
    const before = await tick(db, 'desk-1', fanout, T0)
    const at = await tick(db, 'desk-1', fanout, T0 + 60_000)
    // Then 前者无事发生；后者扇出一次且 occurrence 记为 fired
    expect(before).toMatchObject({ due: 0, fired: 0 })
    expect(at.due).toBe(1)
    expect(calls).toHaveLength(1)
    const row = db.prepare('SELECT status, missed FROM occurrences WHERE schedule_id = ?').get('s1') as { status: string; missed: number }
    expect(row).toEqual({ status: 'fired', missed: 0 })
  })

  it('管理员：重启期间错过的触发全部以 missed 呈现、不得静默消失、且标为减少风险', async () => {
    // Given 一条每 60 秒的调度，进程"停了" 5 分钟
    const db = fixture().orders
    addSchedule(db, { id: 's2', intervalMs: 60_000, atMs: null, nextAtMs: T0 + 60_000, enabled: true, kind: 'rebalance' })
    const { calls, followup } = fakeFollowup()
    const fanout = createThrottledFanout({ followup, now: () => T0, windowMs: 1000, maxPerWindow: 10 })
    // When 在 T0+5min 才 tick
    // 用 5 分钟零 1 毫秒：让第 5 个点也严格落在过去（恰好到点的那个点不算"错过"，它正在被按时触发）
    const result = await tick(db, 'desk-1', fanout, T0 + 5 * 60_000 + 1)
    // Then 错过的那几条全部出现、都被标 missed、整批 reduceOnly
    const missed = calls[0]!.occurrences.filter((occurrence) => occurrence.missed)
    expect(result.due).toBe(5)
    expect(missed).toHaveLength(5)
    expect(result.reduceOnly).toBe(true)
    expect(calls[0]!.reduceOnly).toBe(true)
    expect(calls[0]!.text).toContain('missed while the core was down')
  })

  it('管理员：同一个触发点不会重复扇出（occurrence 主键即幂等键）', async () => {
    // Given 一条一次性调度已触发过
    const db = fixture().orders
    addSchedule(db, { id: 's3', intervalMs: null, atMs: T0 + 1000, nextAtMs: T0 + 1000, enabled: true, kind: 'once' })
    const { calls, followup } = fakeFollowup()
    const fanout = createThrottledFanout({ followup, now: () => T0, windowMs: 1000, maxPerWindow: 5 })
    await tick(db, 'desk-1', fanout, T0 + 1000)
    // When 同一时刻再 tick 一次
    const again = await tick(db, 'desk-1', fanout, T0 + 1000)
    // Then 不再扇出（一次性调度也已禁用）
    expect(calls).toHaveLength(1)
    expect(again.due).toBe(0)
  })
})

describe('扇出节流（followup 每次都是一条独立 turn）', () => {
  it('管理员：窗口内多出来的触发合并成一条并带原始条数（合并不等于丢）', async () => {
    // Given 窗口内 6 条 triggering，节流上限 2
    const db = fixture().orders
    for (let i = 0; i < 6; i += 1) {
      addSchedule(db, { id: 'm' + String(i), intervalMs: null, atMs: T0 + 1, nextAtMs: T0 + 1, enabled: true, kind: 'macro' })
    }
    const { calls, followup } = fakeFollowup()
    const fanout = createThrottledFanout({ followup, now: () => T0, windowMs: 60_000, maxPerWindow: 2 })
    // When tick
    const result = await tick(db, 'desk-1', fanout, T0 + 1)
    // Then 只扇一条，但这一条带着全部 6 个 occurrence，且文本写明合并了几条
    expect(result.due).toBe(6)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.occurrences).toHaveLength(6)
    expect(calls[0]!.text).toContain('coalesced into this turn')
  })

  it('管理员：扇出失败时如实返回 failed 并把 occurrence 记为 failed（不静默丢失）', async () => {
    // Given 一个第一次必失败的 followup
    const db = fixture().orders
    addSchedule(db, { id: 'f1', intervalMs: null, atMs: T0 + 1, nextAtMs: T0 + 1, enabled: true, kind: 'risk' })
    const { followup } = fakeFollowup({ failTimes: 1 })
    const fanout = createThrottledFanout({ followup, now: () => T0, windowMs: 1000, maxPerWindow: 5 })
    // When tick
    const result = await tick(db, 'desk-1', fanout, T0 + 1)
    // Then failed=1 且账本里留下 failed 状态（可查、可重试）
    expect(result).toMatchObject({ due: 1, fired: 0, failed: 1 })
    const row = db.prepare('SELECT status, attempts FROM occurrences WHERE schedule_id = ?').get('f1') as { status: string; attempts: number }
    expect(row.status).toBe('failed')
    expect(row.attempts).toBeGreaterThan(0)
  })
})

describe('会话换代（权威态在账本，不在会话）', () => {
  it('管理员：desk 会话换代后仍能从账本继续，未触发的调度照常到点', async () => {
    // Given 一条调度与一次已完成的 tick（会话 A）
    const db = fixture().orders
    addSchedule(db, { id: 'g1', intervalMs: 60_000, atMs: null, nextAtMs: T0 + 60_000, enabled: true, kind: 'rebalance' })
    const first = fakeFollowup()
    await tick(db, 'desk-A', createThrottledFanout({ followup: first.followup, now: () => T0, windowMs: 1000, maxPerWindow: 5 }), T0 + 60_000)
    // When 换代成 desk-B，再 tick 下一个周期
    const second = fakeFollowup()
    const next = await tick(db, 'desk-B', createThrottledFanout({ followup: second.followup, now: () => T0 + 60_000, windowMs: 1000, maxPerWindow: 5 }), T0 + 120_000)
    // Then 新会话拿到新的触发，且旧会话的记录仍在账本里（权威态不在会话）
    expect(next.due).toBe(1)
    expect(second.calls[0]!.sessionId).toBe('desk-B')
    expect(first.calls[0]!.sessionId).toBe('desk-A')
    const total = db.prepare('SELECT COUNT(*) AS n FROM occurrences').get() as { n: number }
    expect(Number(total.n)).toBe(2)
  })
})

describe('落盘与辅助函数', () => {
  it('管理员：markFired 幂等（同一点重复标记只增 attempts 不改主键）', () => {
    // Given 一个 occurrence
    const db = fixture().orders
    const occurrence: Occurrence = { scheduleId: 'x', dueAtMs: T0, missed: false, kind: 'k' }
    // When 标记两次
    markFired(db, occurrence, T0, 'fired')
    markFired(db, occurrence, T0 + 1, 'failed')
    // Then 只有一行，状态为最后一次，attempts=2
    const rows = db.prepare('SELECT status, attempts FROM occurrences WHERE schedule_id = ?').all('x') as unknown as { status: string; attempts: number }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ status: 'failed', attempts: 2 })
  })

  it('管理员：advanceSchedule 把 nextAt 推到 now 之后（不补发中间点）', () => {
    // Given 一条每 60 秒的调度
    const db = fixture().orders
    addSchedule(db, { id: 'a1', intervalMs: 60_000, atMs: null, nextAtMs: T0, enabled: true, kind: 'k' })
    // When 用"已过 5 分钟"的 now 推进
    advanceSchedule(db, 'a1', T0, T0 + 5 * 60_000)
    // Then 下一跳落在 now 之后
    const row = db.prepare('SELECT next_at_ms FROM schedules WHERE id = ?').get('a1') as { next_at_ms: number }
    expect(Number(row.next_at_ms)).toBeGreaterThan(T0 + 5 * 60_000)
    // 一次性调度则禁用自己
    addSchedule(db, { id: 'a2', intervalMs: null, atMs: T0, nextAtMs: T0, enabled: true, kind: 'k' })
    advanceSchedule(db, 'a2', T0, T0)
    const once = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get('a2') as { enabled: number }
    expect(once.enabled).toBe(0)
  })

  it('管理员：dueOccurrences 忽略已禁用的调度', () => {
    // Given 一条禁用的调度
    const db = fixture().orders
    addSchedule(db, { id: 'd1', intervalMs: 1000, atMs: null, nextAtMs: T0, enabled: false, kind: 'k' })
    // When 算到点
    // Then 为空
    expect(dueOccurrences(db, T0 + 10_000)).toEqual([])
  })

  it('管理员：扇出文本包含条数与种类（人读的叙述）', () => {
    // Given 两条错过的 occurrence
    const text = describeBatch([
      { scheduleId: 's', dueAtMs: T0, missed: true, kind: 'risk' },
      { scheduleId: 's', dueAtMs: T0 + 1, missed: true, kind: 'macro' },
    ])
    // When 生成文本
    // Then 带条数、错过标注与种类
    expect(text).toContain('2 occurrence(s)')
    expect(text).toContain('missed')
    expect(text).toContain('macro')
    expect(text).toContain('risk')
  })
})
