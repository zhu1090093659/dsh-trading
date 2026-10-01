/**
 * 环路自带写探针的测试：用**真实只读目录**触发 probeWritable 失败，
 * 验证环路会把"盘写不进去"并进信号 ⇒ disk-full ⇒ 停止新增风险。
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers } from '../src/db.ts'
import { createJournal } from '../src/journal.ts'
import { migrateDeskRecords } from '../src/desk-records.ts'
import { migrateTriggers } from '../src/triggers.ts'
import { createDeskLoop, type LoopScheduler } from '../src/desk-loop.ts'
import type { MonitorSignals } from '../src/degradation-monitor.ts'

const T0 = 1_700_000_000_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* 可能已删 */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture(probeDir: string, signals: Partial<MonitorSignals> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-probe-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  migrateDeskRecords(ledgers.orders)
  migrateTriggers(ledgers.orders)
  let tick = T0
  const scheduler: LoopScheduler = { schedule: () => () => {} }
  const loop = createDeskLoop({
    orders: ledgers.orders,
    audit: ledgers.audit,
    journal: createJournal(ledgers.audit, { now: () => (tick += 1) }),
    gate: { protectiveOrdersAtVenue: false },
    signals: () => ({
      symbols: ['BTC/USDT'],
      alignmentOf: () => 'aligned',
      lastHeartbeatAtMs: T0,
      heartbeatTimeoutMs: 30_000,
      venueErrorStreak: 0,
      venueErrorThreshold: 3,
      diskWriteFailed: false,
      clockDriftMs: 0,
      clockDriftToleranceMs: 100,
      now: () => tick,
      ...signals,
    }),
    scheduler,
    now: () => (tick += 1),
    intervalMs: 1_000,
    probeDir,
  })
  return loop
}

describe('环路自带写探针', () => {
  it('管理员：盘可写时探针通过，不产 disk-full、不降级', () => {
    // Given 一个可写的探针目录
    const probeDir = mkdtempSync(join(tmpdir(), 'probe-ok-'))
    dirs.push(probeDir)
    const loop = fixture(probeDir)
    // When 跑一轮
    const result = loop.tickOnce()
    // Then 无 disk-full、档位正常、探针结论可见
    expect(result.triggers).not.toContain('disk-full')
    expect(result.state.level).toBe('normal')
    expect(loop.stats().lastProbeReason).toContain('成功')
  })

  it('管理员：盘写不进去时环路自己发现并按 disk-full 降级（不用等调用方上报）', () => {
    // Given 一个只读的探针目录
    const probeDir = mkdtempSync(join(tmpdir(), 'probe-ro-'))
    dirs.push(probeDir)
    chmodSync(probeDir, 0o500)
    const loop = fixture(probeDir)
    // When 跑一轮
    const result = loop.tickOnce()
    // Then 触发源含 disk-full、档位 reduce_only、开新仓被拒，且探针原因可读
    expect(result.triggers).toContain('disk-full')
    expect(result.state.level).toBe('reduce_only')
    expect(loop.openAllowed('BTC/USDT').allowed).toBe(false)
    expect(loop.stats().lastProbeReason).toContain('拒绝新增风险')
  })

  it('管理员：调用方上报的 diskWriteFailed 与探针是"或"关系（任一为真即降级）', () => {
    // Given 盘可写但调用方明确上报写失败
    const probeDir = mkdtempSync(join(tmpdir(), 'probe-or-'))
    dirs.push(probeDir)
    const loop = fixture(probeDir, { diskWriteFailed: true })
    // When 跑一轮
    const result = loop.tickOnce()
    // Then 仍然降级（不能因为探针恰好成功就忽略写入方的实测失败）
    expect(result.triggers).toContain('disk-full')
    expect(result.state.level).toBe('reduce_only')
  })
})
