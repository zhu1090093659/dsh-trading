/**
 * 积压告警测试（不改派发语义，只让"停机久了会补发很多条"可见）。
 * 现实参数：5 秒间隔 + 1 天停机 ⇒ 实测查询上限 1000 条。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers } from '../src/db.ts'
import { addSchedule, migrateTriggers } from '../src/triggers.ts'
import { createTriggerPump, type PumpScheduler } from '../src/pump.ts'

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个泵：调度器为手工（不自动跑），dispatch 记数不做事。 */
function fixture(nextAtMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'pump-backlog-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  migrateTriggers(ledgers.orders)
  addSchedule(ledgers.orders, {
    id: 'sched-5s',
    intervalMs: 5_000,
    atMs: null,
    nextAtMs,
    enabled: true,
    kind: 'probe',
  })
  const warnings: { due: number; atMs: number }[] = []
  let dispatched = 0
  const scheduler: PumpScheduler = { schedule: () => () => {} }
  const pump = createTriggerPump({
    db: ledgers.orders,
    deskSessionId: 'desk',
    dispatch: async () => {
      dispatched += 1
    },
    scheduler,
    now: () => NOW,
    intervalMs: 1_000,
    backlogWarnThreshold: 200,
    onBacklog: (info) => warnings.push({ due: info.due, atMs: info.atMs }),
  })
  return { pump, warnings, dispatchedBatches: () => dispatched }
}

describe('积压告警', () => {
  it('管理员：停机一天（5 秒间隔）触发积压告警，并报出真实条数', () => {
    // Given 一个把 nextAt 推到一天前的调度
    const f = fixture(NOW - 86_400_000)
    // When 泵跑一次
    // Then 告警被调用，且条数达到查询上限量级（实测 1000）
    return f.pump.pumpOnce().then((count) => {
      expect(f.warnings).toHaveLength(1)
      expect(f.warnings[0].due).toBe(count)
      expect(f.warnings[0].due).toBeGreaterThanOrEqual(200)
      expect(f.warnings[0].atMs).toBe(NOW)
    })
  })

  it('管理员：没有积压时不告警（不制造噪音）', () => {
    // Given 一个刚到点的调度（只有 1 条）
    const f = fixture(NOW)
    // When 泵跑一次
    return f.pump.pumpOnce().then((count) => {
      // Then 没到阈值 ⇒ 不告警
      expect(count).toBeLessThan(200)
      expect(f.warnings).toHaveLength(0)
    })
  })

  it('管理员：告警不改变派发行为（仍然只有一次扇出调用）', async () => {
    // Given 停机一天的调度
    const f = fixture(NOW - 86_400_000)
    // When 泵跑一次
    await f.pump.pumpOnce()
    // Then 告警发生，但扇出仍是一次（告警只观察、不拆分也不合并）
    expect(f.warnings.length).toBeGreaterThan(0)
    expect(f.dispatchedBatches()).toBe(1)
  })
})
