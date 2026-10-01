/**
 * gap report 收集器测试：真 node:sqlite + 真表结构（用 openLedgers + migrateTriggers 建库）。
 * 重点是"缺什么就点名什么"，而不是用空数组冒充"期间什么都没发生"。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers } from '../src/db.ts'
import { addSchedule, markFired, migrateTriggers, type Occurrence } from '../src/triggers.ts'
import { collectGapReport } from '../src/gap-collector.ts'
import { createJournal } from '../src/journal.ts'
import { recordPositionChange } from '../src/desk-records.ts'

const T0 = 1_700_000_000_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gap-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  migrateTriggers(ledgers.orders)
  return ledgers
}

describe('gap report 收集器', () => {
  it('管理员：错过的触发能从 occurrences 取到，并带上到点时间', () => {
    // Given 一个被标记为 miss 的 occurrence
    const ledgers = fixture()
    addSchedule(ledgers.orders, { id: 'w-1', intervalMs: 60_000, atMs: null, nextAtMs: T0, enabled: true, kind: 'wake' })
    const occurrence: Occurrence = { scheduleId: 'w-1', dueAtMs: T0 + 1_000, missed: true, kind: 'wake' }
    markFired(ledgers.orders, occurrence, T0 + 2_000, 'failed')
    // When 收集窗口覆盖它
    const collected = collectGapReport(ledgers, { disconnectedFromMs: T0, reconnectedAtMs: T0 + 10_000 })
    // Then 报告里点名这条触发
    expect(collected.report.missedTriggers).toEqual(['w-1@' + String(T0 + 1_000)])
  })

  it('管理员：取不到的输入必须点名，而不是用空数组冒充"什么都没发生"', () => {
    // Given 一个空窗口（期间确实什么都没有）
    const ledgers = fixture()
    // When 收集
    const collected = collectGapReport(ledgers, { disconnectedFromMs: T0, reconnectedAtMs: T0 + 1_000 })
    // Then 报告为空，但**缺口清单不为空**（降级动作无写入点、持仓无历史）
    expect(collected.report.missedTriggers).toEqual([])
    expect(collected.missingInputs.length).toBeGreaterThanOrEqual(1)
    expect(collected.missingInputs.join(' ')).toContain('降级动作')
    // 空库没有任何持仓 ⇒ 不再无中生有地报"持仓"缺口（重建能力已补齐，见后两例）
    expect(collected.missingInputs.join(' ')).toContain('降级动作')
  })

  it('管理员：被拒意图能数条数，并明确说明"理由取不到"', () => {
    // Given 窗口内有两条 rejected 意图
    const ledgers = fixture()
    const insert = ledgers.orders.prepare('INSERT INTO intents (intent_id, client_order_id, symbol, side, quantity, state, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run('i-1', 'c-1', 'BTC/USDT', 'buy', 0.1, 'rejected', T0 + 100, T0 + 200)
    insert.run('i-2', 'c-2', 'ETH/USDT', 'sell', 1, 'rejected', T0 + 300, T0 + 400)
    // When 收集
    const collected = collectGapReport(ledgers, { disconnectedFromMs: T0, reconnectedAtMs: T0 + 1_000 })
    // Then 条数到位、理由缺口点名
    expect(collected.report.rejectedIntents).toEqual(['i-1', 'i-2'])
    expect(collected.missingInputs.join(' ')).toContain('理由')
  })

  it('管理员：窗口外的记录不进报告（窗口边界是闭区间）', () => {
    // Given 一条窗口之前、一条窗口之内的 missed
    const ledgers = fixture()
    addSchedule(ledgers.orders, { id: 'w-1', intervalMs: 60_000, atMs: null, nextAtMs: T0, enabled: true, kind: 'wake' })
    markFired(ledgers.orders, { scheduleId: 'w-1', dueAtMs: T0 - 5_000, missed: true, kind: 'wake' }, T0 - 4_000, 'failed')
    markFired(ledgers.orders, { scheduleId: 'w-1', dueAtMs: T0 + 5_000, missed: true, kind: 'wake' }, T0 + 6_000, 'failed')
    // When 只取窗口内的
    const collected = collectGapReport(ledgers, { disconnectedFromMs: T0, reconnectedAtMs: T0 + 10_000 })
    // Then 只有窗口内那条
    expect(collected.report.missedTriggers).toEqual(['w-1@' + String(T0 + 5_000)])
    expect(collected.report.disconnectedMs).toBe(10_000)
  })

  it('管理员：从 journal 重建"之前/之后"持仓，持仓变化因此完整', () => {
    // Given journal 里窗口前有 0.5（先 0 → 0.5），窗口内变成 0.2
    const ledgers = fixture()
    const journal = createJournal(ledgers.audit, { now: () => T0 })
    recordPositionChange(ledgers.orders, journal, { symbol: 'BTC/USDT', quantity: 0.5, atMs: T0 - 10_000 })
    recordPositionChange(ledgers.orders, journal, { symbol: 'BTC/USDT', quantity: 0.2, atMs: T0 + 5_000 })
    // When 收集窗口 [T0, T0+10s]
    const collected = collectGapReport(ledgers, { disconnectedFromMs: T0, reconnectedAtMs: T0 + 10_000 })
    // Then 之前的持仓来自 journal（0.5），变化被报出来
    expect(collected.report.positionChanges).toEqual([{ symbol: 'BTC/USDT', from: 0.5, to: 0.2 }])
    expect(collected.missingInputs.join(' ')).not.toContain('positionsBefore 为空')
  })

  it('管理员：journal 里没有历史时，兜底用当前持仓并如实说明偏差', () => {
    // Given 只有 positions 当前值、journal 无记录
    const ledgers = fixture()
    ledgers.orders.prepare('INSERT INTO positions (symbol, quantity, updated_ms) VALUES (?, ?, ?)').run('ETH/USDT', 3, T0)
    // When 收集
    const collected = collectGapReport(ledgers, { disconnectedFromMs: T0, reconnectedAtMs: T0 + 1_000 })
    // Then 报告给出"之后"，并点名偏差
    expect(collected.report.positionChanges).toEqual([{ symbol: 'ETH/USDT', from: 0, to: 3 }])
    expect(collected.missingInputs.join(' ')).toContain('positions 当前值')
  })
})
