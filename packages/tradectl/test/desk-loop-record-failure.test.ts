/**
 * 审计写入失败的行为测试（"磁盘满 ⇒ 拒写 + 明确报错，不得静默丢审计"）：
 * 用 SQLite 自己的 %%max_page_count%% 制造 SQLITE_FULL（等价磁盘满，安全且不动真实磁盘）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers, type Ledgers } from '../src/db.ts'
import { createJournal, type Journal, type JournalEvent, type JournalPage } from '../src/journal.ts'
import { migrateDeskRecords } from '../src/desk-records.ts'
import { migrateTriggers } from '../src/triggers.ts'
import { createDeskLoop, type LoopScheduler } from '../src/desk-loop.ts'
import type { MonitorSignals } from '../src/degradation-monitor.ts'

const T0 = 1_700_000_000_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'record-fail-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  migrateDeskRecords(ledgers.orders)
  migrateTriggers(ledgers.orders)
  return { dir, ledgers }
}

/** 把 audit 库的页数上限压到当前值 ⇒ 任何需要新页的写入都会以 database or disk is full 失败。 */
function starve(database: Ledgers['audit']): void {
  const row = database.prepare('PRAGMA page_count').get() as { page_count: number }
  database.exec('PRAGMA max_page_count = ' + String(row.page_count))
}

/** 契约假件：满足 Journal 接口，append 按开关抛错（用于验环路的 fail-safe 行为）。 */
function fakeJournal(options: { failFrom?: number } = {}) {
  const events: JournalEvent[] = []
  // 默认**永不失败**（第一版写成 ?? 0，于是"健康"用例其实一直在失败）
  const failFrom = options.failFrom ?? Number.POSITIVE_INFINITY
  let seq = 0
  const journal: Journal = {
    append(kind: string, payload: unknown, atMs?: number): JournalEvent {
      if (seq >= failFrom) throw new Error('database or disk is full')
      seq += 1
      const event: JournalEvent = { seq, atMs: atMs ?? T0, kind, payload: payload ?? null }
      events.push(event)
      return event
    },
    read(cursor: number): JournalPage {
      return { events: events.filter((event) => event.seq > cursor), nextCursor: seq }
    },
    latestSeq: () => seq,
    retain: () => ({ pruned: 0, snapshotSeq: null }),
    latestSnapshot: () => undefined,
  }
  return { journal, events }
}

function loopWith(journal: Journal) {
  const dir = mkdtempSync(join(tmpdir(), 'record-fail-loop-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  migrateDeskRecords(ledgers.orders)
  migrateTriggers(ledgers.orders)
  let tick = T0
  const scheduler: LoopScheduler = { schedule: () => () => {} }
  const signals = (): MonitorSignals => ({
    symbols: ['BTC/USDT'],
    alignmentOf: () => 'stale',
    lastHeartbeatAtMs: T0,
    heartbeatTimeoutMs: 30_000,
    venueErrorStreak: 0,
    venueErrorThreshold: 3,
    diskWriteFailed: false,
    now: () => tick,
  })
  const loop = createDeskLoop({
    orders: ledgers.orders,
    audit: ledgers.audit,
    journal,
    gate: { protectiveOrdersAtVenue: false },
    signals,
    scheduler,
    now: () => (tick += 1),
    intervalMs: 1_000,
  })
  return loop
}

describe('审计写入失败：拒写要响亮，不能静默丢', () => {
  it('管理员：库写不进去时 journal.append 抛错（不是静默成功）', () => {
    // Given 一个页数上限被压到当前值的 audit 库
    const f = fixture()
    const journal = createJournal(f.ledgers.audit, { now: () => Date.now() })
    journal.append('before', { ok: true })
    starve(f.ledgers.audit)
    // When 继续写
    // Then 抛出 SQLITE_FULL（"database or disk is full"），调用方无法把它当成成功
    expect(() => {
      for (let index = 0; index < 500; index += 1) journal.append('fill', { index, pad: 'x'.repeat(400) })
    }).toThrow(/disk is full|database is full/i)
  })

  it('管理员：记录失败时环路不崩，计数并记住原因（"审计可能缺行"必须可见）', () => {
    // Given 一个从第一次写入就失败的 journal
    const { journal } = fakeJournal({ failFrom: 0 })
    const loop = loopWith(journal)
    // When 跑一轮（会尝试记录降级过渡）
    const result = loop.tickOnce()
    // Then 不抛错、状态照样更新、失败被计数并留下原因
    expect(result.state.symbols['BTC/USDT']?.alignment).toBe('stale')
    expect(loop.stats().recordFailures).toBeGreaterThan(0)
    expect(loop.stats().lastRecordFailure).toContain('disk is full')
  })

  it('管理员：记录失败过的下一轮按 disk-full 降级（存储坏了就停止新增风险）', () => {
    // Given 记录一直失败
    const { journal } = fakeJournal({ failFrom: 0 })
    const loop = loopWith(journal)
    // When 先跑一轮暴露失败，再跑一轮
    loop.tickOnce()
    const second = loop.tickOnce()
    // Then 第二轮把 disk-full 并进触发源 ⇒ desk 降为 reduce_only（不再新增风险）
    expect(second.triggers).toContain('disk-full')
    expect(second.state.level).toBe('reduce_only')
    expect(loop.openAllowed('BTC/USDT').allowed).toBe(false)
  })

  it('管理员：记录正常时统计里没有失败（不要把健康说成坏）', () => {
    // Given 一个正常 journal
    const { journal } = fakeJournal()
    const loop = loopWith(journal)
    // When 跑两轮
    loop.tickOnce()
    loop.tickOnce()
    // Then 无失败计数
    expect(loop.stats().recordFailures).toBe(0)
    expect(loop.stats().lastRecordFailure).toBeNull()
  })
})
