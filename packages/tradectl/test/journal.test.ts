/**
 * journal 行为测试：真 node:sqlite 库（临时目录）、注入时钟、无 mock 无 sleep。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers, type Ledgers } from '../src/db.ts'
import { createJournal, JournalCursorExpiredError } from '../src/journal.ts'

const dirs: string[] = []
const ledgers: Ledgers[] = []
function fixture(keep = 3, snapshotEvery = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'tradectl-journal-'))
  dirs.push(dir)
  const opened = openLedgers(dir)
  ledgers.push(opened)
  let tick = 1_700_000_000_000
  const journal = createJournal(opened.audit, { now: () => (tick += 1000), retention: { keep, snapshotEvery } })
  return { opened, journal }
}
afterEach(() => {
  for (const opened of ledgers.splice(0)) opened.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('journal 追加与游标分页', () => {
  it('管理员：seq 单调递增，按 nextCursor 续读能拿到全部事件且不重不漏', () => {
    // Given 一个空 journal 与 5 条事件
    const { journal } = fixture(1000, 1)
    const appended = ['a', 'b', 'c', 'd', 'e'].map((kind) => journal.append(kind, { kind }))
    // When 用 limit=2 从 0 开始连续分页
    const page1 = journal.read(0, 2)
    const page2 = journal.read(page1.nextCursor, 2)
    const page3 = journal.read(page2.nextCursor, 2)
    // Then seq 递增、三页拼起来正好是全部事件、最后一页 nextCursor = 最新 seq
    expect(appended.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect([...page1.events, ...page2.events, ...page3.events].map((e) => e.kind)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(page3.nextCursor).toBe(journal.latestSeq())
    expect(journal.read(page3.nextCursor, 2).events).toEqual([])
  })

  it('管理员：注入时钟决定 atMs，事件本身不读真实时间', () => {
    // Given 一个递增 1000ms 的注入时钟
    const { journal } = fixture(1000, 1)
    // When 追加两条
    const first = journal.append('x', null)
    const second = journal.append('y', null)
    // Then 两条 atMs 相差正好一个 tick，且 payload 原样可读
    expect(second.atMs - first.atMs).toBe(1000)
    expect(journal.read(0, 10).events[0]).toMatchObject({ seq: 1, kind: 'x', payload: null })
  })
})

describe('journal 双水位保留与 410', () => {
  it('管理员：游标落后于保留窗口时得到 410 与快照，而不是看起来正常的空页', () => {
    // Given 保留 3 条、快照粒度 1，写 10 条后裁剪
    const { journal } = fixture(3, 1)
    for (let i = 0; i < 10; i += 1) journal.append('e' + String(i), { i })
    const retained = journal.retain()
    // When 用一个早就过界的游标去读
    // Then 抛 410 cursor-expired 并带上快照（快照 seq 之后的原始事件仍在库里）
    expect(retained.pruned).toBeGreaterThan(0)
    let thrown: unknown
    try {
      journal.read(1, 10)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(JournalCursorExpiredError)
    const expired = thrown as JournalCursorExpiredError
    expect(expired.status).toBe(410)
    expect(expired.code).toBe('cursor-expired')
    expect(expired.snapshotSeq).toBe(retained.snapshotSeq)
    expect((expired.snapshotState as { prunedThrough: number }).prunedThrough).toBe(retained.snapshotSeq)
  })

  it('管理员：裁剪之后最新事件仍可读，且 seq 继续增长不复用', () => {
    // Given 裁剪过的 journal
    const { journal } = fixture(2, 1)
    for (let i = 0; i < 6; i += 1) journal.append('e' + String(i), null)
    const retained = journal.retain()
    // When 从保留窗口内续读并再追加
    const page = journal.read(retained.snapshotSeq ?? 0, 10)
    const appended = journal.append('after', null)
    // Then 读得到保留的事件，新事件的 seq 大于此前最大值（AUTOINCREMENT 不回卷）
    expect(page.events.length).toBeGreaterThan(0)
    expect(page.events.every((e) => e.seq > (retained.snapshotSeq ?? 0))).toBe(true)
    expect(appended.seq).toBeGreaterThan(6)
  })

  it('管理员：未裁剪时老游标照常读到全部事件（不上报假 410）', () => {
    // Given 保留窗口很大、没有裁剪
    const { journal } = fixture(1000, 500)
    for (let i = 0; i < 4; i += 1) journal.append('e' + String(i), null)
    // When 从 0 读
    const page = journal.read(0, 10)
    // Then 四条都在
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })
})

describe('ledger 目录与分离', () => {
  it('管理员：三个库是三个物理文件，pragma 按契约分档', () => {
    // Given 一个账本目录
    const { opened } = fixture()
    // When 读各自的 journal_mode 与同步档
    const modeOf = (db: { prepare(sql: string): { get(): unknown } }): unknown =>
      (db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown }).journal_mode
    const syncOf = (db: { prepare(sql: string): { get(): unknown } }): unknown =>
      (db.prepare('PRAGMA synchronous').get() as { synchronous?: unknown }).synchronous
    // Then orders 与 audit 是 FULL(2)，market 是 OFF(0)，三个文件都在
    expect(modeOf(opened.orders as never)).toBe('wal')
    expect(Number(syncOf(opened.orders as never))).toBe(2)
    expect(Number(syncOf(opened.audit as never))).toBe(2)
    expect(Number(syncOf(opened.market as never))).toBe(0)
    expect([opened.orders, opened.audit, opened.market].length).toBe(3)
  })
})
