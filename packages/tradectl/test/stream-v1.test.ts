/**
 * 下行面测试（P4 步骤 3）：真 journal（node:sqlite）+ 记录帧的假 socket，无 mock 框架、无 sleep。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createJournal } from '../src/journal.ts'
import { openLedgers } from '../src/db.ts'
import { createV1Stream, type DownstreamFrame } from '../src/stream-v1.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(over: { scopes?: ('read' | 'command' | 'control')[]; maxBatch?: number; keep?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stream-v1-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  let tick = 1_700_000_000_000
  const journal = createJournal(ledgers.audit, {
    now: () => (tick += 1),
    retention: { keep: over.keep ?? 4, snapshotEvery: 2 },
  })
  const frames: DownstreamFrame[] = []
  let closes = 0
  const socket = {
    send: (text: string) => frames.push(JSON.parse(text) as DownstreamFrame),
    close: () => { closes += 1 },
  }
  const stream = createV1Stream({ journal, scopes: over.scopes ?? ['read'], ...(over.maxBatch === undefined ? {} : { maxBatch: over.maxBatch }) })
  return { journal, frames, socket, stream, ledgers, get closes() { return closes } }
}

describe('下行与游标', () => {
  it('管理员：带游标连接后从该游标续推，seq 严格递增', () => {
    // Given 三条已写入的事件
    const { journal, frames, socket, stream } = fixture()
    journal.append('a', { n: 1 })
    journal.append('b', { n: 2 })
    journal.append('c', { n: 3 })
    // When 从游标 0 连接并推进
    const session = stream.attach(socket, 0)
    session.pump()
    // Then 三条事件按序下行
    expect(frames.map((frame) => (frame.type === 'event' ? frame.seq : -1))).toEqual([1, 2, 3])
    expect(session.cursor).toBe(3)
  })

  it('管理员：不带游标时只推新事件（"只要新的"必须由客户端显式选择）', () => {
    // Given 已有两条历史事件
    const { journal, frames, socket, stream } = fixture()
    journal.append('old', { n: 1 })
    journal.append('old', { n: 2 })
    // When 不带游标连接
    const session = stream.attach(socket)
    // Then 历史不下行；新事件才下行
    expect(session.pump()).toBe(0)
    journal.append('fresh', { n: 3 })
    session.pump()
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'event', kind: 'fresh' })
  })

  it('管理员：游标落后于保留窗口时下发 resync 帧并从快照续读（不静默跳跃）', () => {
    // Given 保留窗口很小（keep 4）且已裁过一轮
    const { journal, frames, socket, stream } = fixture({ keep: 2 })
    for (let index = 0; index < 6; index += 1) journal.append('e' + String(index), { index })
    journal.retain()
    // When 用一个已被裁掉的游标连接
    const session = stream.attach(socket, 1)
    session.pump()
    // Then 第一帧是 resync，且带着快照位置与状态
    const first = frames[0]
    expect(first?.type).toBe('resync')
    if (first?.type === 'resync') {
      expect(first.reason).toBe('cursor-expired')
      expect(first.snapshotSeq).toBeGreaterThan(1)
      expect(session.cursor).toBeGreaterThanOrEqual(first.snapshotSeq)
    }
    // 且 resync 之后继续推的是新事件（不是从 1 开始重复推）
    const eventSeqs = frames.filter((frame) => frame.type === 'event').map((frame) => (frame.type === 'event' ? frame.seq : 0))
    expect(eventSeqs.every((seq) => seq > 1)).toBe(true)
  })

  it('管理员：单向下行——客户端发来的任何内容都被忽略，不下行、不报错', () => {
    // Given 一条已连接的会话
    const { journal, frames, socket, stream } = fixture()
    journal.append('a', { n: 1 })
    const session = stream.attach(socket, 0)
    // When 客户端发一条"顺带指令"
    const verdict = session.onClientMessage(JSON.stringify({ action: 'kill' }))
    // Then 一律 ignored、帧数不变（下行连接不接受业务指令）
    expect(verdict).toBe('ignored')
    expect(frames).toHaveLength(0)
    expect(session.pump()).toBe(1)
  })

  it('管理员：缺 read 平面时只下发 error 帧并关闭连接（一个事件都不推）', () => {
    // Given 一个只有 command 平面的调用方
    const { journal, frames, socket, stream } = fixture({ scopes: ['command'] })
    journal.append('a', { n: 1 })
    // When 连接
    const session = stream.attach(socket, 0)
    // Then error 帧 + 已关闭 + pump 不再推任何东西
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'error', code: 'SCOPE_REQUIRED' })
    expect(session.closed).toBe(true)
    expect(session.pump()).toBe(0)
  })

  it('管理员：maxBatch 限制每轮帧数（背压：慢客户端不拖垮服务端）', () => {
    // Given 十条事件与批次上限 3
    const { journal, frames, socket, stream } = fixture({ maxBatch: 3 })
    for (let index = 0; index < 10; index += 1) journal.append('e', { index })
    // When 推进一轮
    const session = stream.attach(socket, 0)
    const sent = session.pump()
    // Then 只发 3 帧，剩余留给下一轮
    expect(sent).toBe(3)
    expect(frames).toHaveLength(3)
    expect(session.pump()).toBe(3)
  })
})
