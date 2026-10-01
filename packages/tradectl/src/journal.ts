/**
 * append-only journal（P2 步骤 2）：单调 seq、游标分页、双水位保留、410 由快照承接。
 *
 * 三条不变量，都是可执行断言而不是散文：
 *   1. 只追加：没有 UPDATE/DELETE 路径，seq 由 AUTOINCREMENT 保证单调且不复用
 *      （删掉的行不会让 seq 回卷——这是「游标可比大小」的前提）；
 *   2. 游标可比大小：调用方只拿 seq 当游标，服务端按 seq > cursor 取下一页；
 *   3. 保留有底：裁掉的老事件必须先落快照，否则读老游标的人会**无声丢一段历史**。
 *      过界时抛 410 cursor-expired 并把最近的快照一并给出——调用方拿到的是
 *      「你落后太多，从这份状态重建」，而不是一个看起来正常的空页。
 *
 * 双水位：keep = 完整保留的最新事件数；snapshotEvery = 被裁事件每积累这么多就落
 * 一份快照（第二水位）。快照里的 state 是重建摘要，不是事件副本。
 *
 * @module @dshtrading/tradectl/journal
 */
import type { DatabaseSync } from 'node:sqlite'

/** 一条日志事件。 */
export interface JournalEvent {
  readonly seq: number
  readonly atMs: number
  readonly kind: string
  readonly payload: unknown
}

/** 一页事件。nextCursor 传回 read() 即续读。 */
export interface JournalPage {
  readonly events: readonly JournalEvent[]
  readonly nextCursor: number
}

/** 游标落后于保留窗口：调用方必须从 snapshot 重建。 */
export class JournalCursorExpiredError extends Error {
  readonly code = 'cursor-expired'
  readonly status = 410
  readonly snapshotSeq: number
  readonly snapshotState: unknown
  constructor(cursor: number, snapshotSeq: number, snapshotState: unknown) {
    super('cursor ' + String(cursor) + ' predates the retained window; resume from snapshot at seq ' + String(snapshotSeq))
    this.name = 'JournalCursorExpiredError'
    this.snapshotSeq = snapshotSeq
    this.snapshotState = snapshotState
  }
}

export interface JournalOptions {
  /** 注入的时钟（测试不许 sleep，也不许读真实时间）。 */
  readonly now: () => number
  /** 双水位：完整保留的最新事件数 + 快照粒度。 */
  readonly retention?: { readonly keep: number; readonly snapshotEvery: number }
}

export interface Journal {
  append(kind: string, payload: unknown): JournalEvent
  read(cursor: number, limit?: number): JournalPage
  latestSeq(): number
  /** 裁剪到保留窗口并（按粒度）落快照；返回这次裁掉的条数与快照 seq。 */
  retain(): { pruned: number; snapshotSeq: number | null }
  /** 最近一份快照（没有则为 undefined）。 */
  latestSnapshot(): { seq: number; atMs: number; state: unknown } | undefined
}

const DEFAULT_RETENTION = { keep: 1000, snapshotEvery: 500 }

interface Row {
  seq: number
  at_ms: number
  kind: string
  payload: string
}

/**
 * 在 audit.db 上开一个 journal。表由 openLedgers 的 migrate 建好。
 * @param db - audit.db 句柄。
 * @param options - 时钟与保留窗口。
 */
export function createJournal(db: DatabaseSync, options: JournalOptions): Journal {
  const retention = options.retention ?? DEFAULT_RETENTION
  const now = options.now

  const append: Journal['append'] = (kind, payload) => {
    const atMs = now()
    const info = db.prepare('INSERT INTO journal (at_ms, kind, payload) VALUES (?, ?, ?)').run(atMs, kind, JSON.stringify(payload ?? null))
    const seq = Number(info.lastInsertRowid)
    return { seq, atMs, kind, payload: payload ?? null }
  }

  const latestSeq = (): number => {
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM journal').get() as { seq: number } | undefined
    return row === undefined ? 0 : Number(row.seq)
  }

  const latestSnapshot = (): { seq: number; atMs: number; state: unknown } | undefined => {
    const row = db.prepare('SELECT seq, at_ms, state FROM snapshots ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number; at_ms: number; state: string }
      | undefined
    if (row === undefined) return undefined
    return { seq: Number(row.seq), atMs: Number(row.at_ms), state: JSON.parse(row.state) }
  }

  const read: Journal['read'] = (cursor, limit = 200) => {
    const oldest = db.prepare('SELECT MIN(seq) AS seq FROM journal').get() as { seq: number | null } | undefined
    const snapshot = latestSnapshot()
    // 过界判定：游标之后的事件里，最老的一条已经不是 cursor+1 ⇒ 中间有洞。
    // 洞的存在由快照水位刻画：快照 seq 之前的原始事件已经被裁掉。
    if (snapshot !== undefined && cursor < snapshot.seq) {
      throw new JournalCursorExpiredError(cursor, snapshot.seq, snapshot.state)
    }
    if (cursor > 0 && oldest !== undefined && oldest.seq !== null && cursor < Number(oldest.seq) - 1) {
      throw new JournalCursorExpiredError(cursor, snapshot === undefined ? 0 : snapshot.seq, snapshot === undefined ? null : snapshot.state)
    }
    const rows = db
      .prepare('SELECT seq, at_ms, kind, payload FROM journal WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(cursor, limit) as unknown as Row[]
    const events: JournalEvent[] = rows.map((row) => ({
      seq: Number(row.seq),
      atMs: Number(row.at_ms),
      kind: row.kind,
      payload: JSON.parse(row.payload) as unknown,
    }))
    const last = events.length === 0 ? cursor : events[events.length - 1]!.seq
    return { events, nextCursor: last }
  }

  const retain: Journal['retain'] = () => {
    const total = latestSeq()
    const cutoff = total - retention.keep
    if (cutoff <= 0) return { pruned: 0, snapshotSeq: null }
    const snapshot = latestSnapshot()
    const alreadyPruned = snapshot === undefined ? 0 : snapshot.seq
    if (cutoff <= alreadyPruned) return { pruned: 0, snapshotSeq: null }
    if (cutoff - alreadyPruned < retention.snapshotEvery && alreadyPruned > 0) {
      return { pruned: 0, snapshotSeq: null }
    }
    const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM journal WHERE seq <= ? GROUP BY kind').all(cutoff) as unknown as {
      kind: string
      n: number
    }[]
    const counts: Record<string, number> = {}
    for (const row of rows) counts[row.kind] = Number(row.n)
    const state = { prunedThrough: cutoff, counts }
    db.prepare('INSERT OR REPLACE INTO snapshots (seq, at_ms, state) VALUES (?, ?, ?)').run(cutoff, now(), JSON.stringify(state))
    const info = db.prepare('DELETE FROM journal WHERE seq <= ?').run(cutoff)
    return { pruned: Number(info.changes), snapshotSeq: cutoff }
  }

  return { append, read, latestSeq, retain, latestSnapshot }
}
