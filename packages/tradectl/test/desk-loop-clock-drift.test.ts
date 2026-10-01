/**
 * 环路自带时钟漂移自检的测试（把"零调用点"的 createClockDriftDetector 接进运行时）。
 * 注入假时钟：墙钟与单调钟的增量不一致 ⇒ 判漂移 ⇒ clock-drift 触发。
 */
import { mkdtempSync, rmSync } from 'node:fs'
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
const M0 = 5_000_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'loop-drift-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  migrateDeskRecords(ledgers.orders)
  migrateTriggers(ledgers.orders)
  let wall = T0
  let mono = M0
  const journal = createJournal(ledgers.audit, { now: () => wall })
  const scheduler: LoopScheduler = { schedule: () => () => {} }
  const loop = createDeskLoop({
    orders: ledgers.orders,
    audit: ledgers.audit,
    journal,
    gate: { protectiveOrdersAtVenue: false },
    signals: (): MonitorSignals => ({
      symbols: ['BTC/USDT'],
      alignmentOf: () => 'aligned',
      lastHeartbeatAtMs: wall,
      heartbeatTimeoutMs: 30_000,
      venueErrorStreak: 0,
      venueErrorThreshold: 3,
      diskWriteFailed: false,
      now: () => wall,
    }),
    scheduler,
    now: () => wall,
    intervalMs: 1_000,
    clockDriftToleranceMs: 1_000,
    monotonicNow: () => mono,
  })
  return {
    loop,
    advance: (wallMs: number, monoMs: number) => {
      wall += wallMs
      mono += monoMs
    },
  }
}

describe('环路自带时钟漂移自检', () => {
  it('管理员：墙钟被拨快而单调钟正常 ⇒ 触发 clock-drift 且降级', () => {
    // Given 一个配了漂移容差的环路，先跑一轮建立基线
    const f = fixture()
    const first = f.loop.tickOnce()
    // Then 首轮只做基线，不判漂移
    expect(first.triggers).not.toContain('clock-drift')
    // When 墙钟跳 5 秒而单调钟只走 1 秒
    f.advance(5_000, 1_000)
    const second = f.loop.tickOnce()
    // Then 命中 clock-drift 且档位降为 reduce_only（拒绝新增风险）
    expect(second.triggers).toContain('clock-drift')
    expect(second.state.level).toBe('reduce_only')
    expect(f.loop.openAllowed('BTC/USDT').allowed).toBe(false)
  })

  it('管理员：两条时钟同步前进时不触发（不制造噪音）', () => {
    // Given 同上
    const f = fixture()
    f.loop.tickOnce()
    // When 墙钟与单调钟都走 1 秒
    f.advance(1_000, 1_000)
    const second = f.loop.tickOnce()
    // Then 不触发 clock-drift、档位保持正常
    expect(second.triggers).not.toContain('clock-drift')
    expect(second.state.level).toBe('normal')
  })
})
