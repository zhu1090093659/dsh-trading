/**
 * desk 记录写入者测试：真 node:sqlite + 真 journal；重点是"理由要留痕""只在变化时记账"。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers } from '../src/db.ts'
import { createJournal } from '../src/journal.ts'
import { migrateDeskRecords, recordDegradation, recordIntent, recordIntentRejection, recordPositionChange } from '../src/desk-records.ts'
import { collectGapReport } from '../src/gap-collector.ts'
import { migrateTriggers } from '../src/triggers.ts'

const T0 = 1_700_000_000_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'desk-records-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  migrateDeskRecords(ledgers.orders)
  // 收集器会查 occurrences（错过的触发存在那里），表由 migrateTriggers 建
  migrateTriggers(ledgers.orders)
  const journal = createJournal(ledgers.audit, { now: () => T0 })
  return { ledgers, journal }
}

describe('desk 记录写入者', () => {
  it('管理员：迁移幂等——重复执行不会重复加列', () => {
    // Given 已迁移过的库
    const { ledgers } = fixture()
    // When 再迁移一次
    migrateDeskRecords(ledgers.orders)
    // Then reason 列恰好一列
    const columns = ledgers.orders.prepare('PRAGMA table_info(intents)').all() as { name: string }[]
    expect(columns.filter((column) => column.name === 'reason')).toHaveLength(1)
  })

  it('管理员：被拒意图带理由落库，gap 收集器随后能给出理由分布', () => {
    // Given 两条带不同理由的被拒意图
    const { ledgers, journal } = fixture()
    recordIntentRejection(ledgers.orders, { intentId: 'i-1', clientOrderId: 'c-1', symbol: 'BTC/USDT', side: 'buy', quantity: 0.1, atMs: T0 + 100, reason: 'desk level is reduce_only' })
    recordIntentRejection(ledgers.orders, { intentId: 'i-2', clientOrderId: 'c-2', symbol: 'ETH/USDT', side: 'buy', quantity: 1, atMs: T0 + 200, reason: 'BTC/USDT price alignment is stale' })
    // When 收集 gap
    const collected = collectGapReport(ledgers, { disconnectedFromMs: T0, reconnectedAtMs: T0 + 1_000 })
    // Then 报告里带理由（不再只是条数）
    expect(collected.report.rejectedIntents).toEqual(['i-1:desk level is reduce_only', 'i-2:BTC/USDT price alignment is stale'])
    expect(collected.missingInputs.join(' ')).not.toContain('理由')
    void journal
  })

  it('管理员：持仓只在数量变化时记 journal（不淹没真正的变化）', () => {
    // Given 空持仓
    const { ledgers, journal } = fixture()
    // When 首次写入 0.5 / 再写同样的值 / 再改成 0.2
    const first = recordPositionChange(ledgers.orders, journal, { symbol: 'BTC/USDT', quantity: 0.5, atMs: T0 })
    const same = recordPositionChange(ledgers.orders, journal, { symbol: 'BTC/USDT', quantity: 0.5, atMs: T0 + 1 })
    const changed = recordPositionChange(ledgers.orders, journal, { symbol: 'BTC/USDT', quantity: 0.2, atMs: T0 + 2 })
    // Then 只有两次真正的变化被记账
    expect([first, same, changed]).toEqual([true, false, true])
    const page = journal.read(0, 10)
    expect(page.events.filter((event) => event.kind === 'position.change')).toHaveLength(2)
    expect(page.events[0]?.payload).toMatchObject({ symbol: 'BTC/USDT', from: 0, to: 0.5 })
    expect(page.events[1]?.payload).toMatchObject({ from: 0.5, to: 0.2 })
  })

  it('管理员：降级动作进 journal，且能被 gap 收集器认出来', () => {
    // Given 一条降级动作
    const { ledgers, journal } = fixture()
    recordDegradation(journal, { trigger: 'market-stale', from: 'normal', to: 'reduce_only', reason: 'BTC/USDT stale beyond budget' })
    // When 收集 gap
    const collected = collectGapReport(ledgers, { disconnectedFromMs: T0, reconnectedAtMs: T0 + 1_000 })
    // Then 降级动作被收集到（不再是"没有写入点"）
    expect(collected.report.degradationActions.length).toBe(1)
    expect(collected.missingInputs.join(' ')).not.toContain('没有写入点')
  })

  it('管理员：意图重复落库是幂等的（同 id 更新状态而不是报错）', () => {
    // Given 同一条意图写两次
    const { ledgers } = fixture()
    recordIntent(ledgers.orders, { intentId: 'i-1', clientOrderId: 'c-1', symbol: 'BTC/USDT', side: 'buy', quantity: 0.1, state: 'new', atMs: T0 })
    recordIntent(ledgers.orders, { intentId: 'i-1', clientOrderId: 'c-1', symbol: 'BTC/USDT', side: 'buy', quantity: 0.1, state: 'filled', atMs: T0 + 5, venueOrderId: 'v-1' })
    // When/Then 只有一条，状态已更新
    const rows = ledgers.orders.prepare('SELECT state, venue_order_id FROM intents').all() as { state: string; venue_order_id: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'filled', venue_order_id: 'v-1' })
  })
})
