/**
 * desk 运行时环路测试：把整条链（信号 → 触发源 → 决策 → 风控状态 → 留痕 → gap report）跑通。
 * 真 node:sqlite + 真 journal + 注入时钟与调度器；无 sleep、无 mock 框架。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers } from '../src/db.ts'
import { createJournal } from '../src/journal.ts'
import { migrateTriggers } from '../src/triggers.ts'
import { migrateDeskRecords } from '../src/desk-records.ts'
import { createDeskLoop, type LoopScheduler } from '../src/desk-loop.ts'
import type { MonitorSignals } from '../src/degradation-monitor.ts'

const T0 = 1_700_000_000_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 可手工推进的调度器：把"等 N 毫秒"变成"取出回调来跑"。 */
function manualScheduler() {
  const pending: { callback: () => void; cancelled: boolean }[] = []
  const scheduler: LoopScheduler = {
    schedule(callback) {
      const entry = { callback, cancelled: false }
      pending.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  }
  return {
    scheduler,
    async fire() {
      for (const entry of pending.splice(0)) if (!entry.cancelled) entry.callback()
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

function fixture(initial: Partial<MonitorSignals> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'desk-loop-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  migrateDeskRecords(ledgers.orders)
  migrateTriggers(ledgers.orders)
  let tick = T0
  const journal = createJournal(ledgers.audit, { now: () => (tick += 1) })
  const clock = manualScheduler()
  let signals: MonitorSignals = {
    symbols: ['BTC/USDT'],
    alignmentOf: () => 'aligned',
    lastHeartbeatAtMs: T0,
    heartbeatTimeoutMs: 30_000,
    venueErrorStreak: 0,
    venueErrorThreshold: 3,
    diskWriteFailed: false,
    now: () => tick,
    ...initial,
  }
  const loop = createDeskLoop({
    orders: ledgers.orders,
    audit: ledgers.audit,
    journal,
    gate: { protectiveOrdersAtVenue: false },
    signals: () => signals,
    scheduler: clock.scheduler,
    now: () => (tick += 1),
    intervalMs: 1_000,
  })
  return { ledgers, journal, loop, clock, setSignals: (next: Partial<MonitorSignals>) => { signals = { ...signals, ...next } } }
}

describe('desk 运行时环路', () => {
  it('管理员：行情陈旧 ⇒ 该标的被降为 stale、开新仓被拒、且留痕一条', () => {
    // Given 一只标的陈旧
    const f = fixture({ alignmentOf: (symbol) => (symbol === 'BTC/USDT' ? 'stale' : 'aligned') })
    // When 跑一轮
    const result = f.loop.tickOnce()
    // Then 触发源命中、开仓被拒、journal 里有一条降级过渡
    expect(result.triggers).toEqual(['market-stale'])
    expect(f.loop.openAllowed('BTC/USDT').allowed).toBe(false)
    expect(result.transitions).toBe(1)
    const events = f.journal.read(0, 10).events.filter((event) => event.kind === 'degradation.transition')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ trigger: 'market-stale', to: 'stale' })
  })

  it('管理员：恢复后回到可开仓，并且"回来了"同样留痕（不闩锁）', () => {
    // Given 先陈旧后恢复
    const f = fixture({ alignmentOf: () => 'stale' })
    f.loop.tickOnce()
    expect(f.loop.openAllowed('BTC/USDT').allowed).toBe(false)
    // When 行情恢复
    f.setSignals({ alignmentOf: () => 'aligned' })
    const recovered = f.loop.tickOnce()
    // Then 重新可开仓，且多了一条 transition（否则事后只看到降下去、看不到回来）
    expect(f.loop.openAllowed('BTC/USDT').allowed).toBe(true)
    expect(recovered.transitions).toBe(1)
    const payloads = f.journal.read(0, 20).events.filter((event) => event.kind === 'degradation.transition').map((event) => event.payload as { to: string })
    expect(payloads.map((payload) => payload.to)).toEqual(['stale', 'aligned'])
  })

  it('管理员：全局故障把 desk 降到 reduce_only，且**永不产 halt**', () => {
    // Given 心跳丢失 + 磁盘写失败 + 交易所连续报错（三个全局触发源）
    const f = fixture({ lastHeartbeatAtMs: T0 - 99_999, diskWriteFailed: true, venueErrorStreak: 9 })
    // When 跑一轮
    const result = f.loop.tickOnce()
    // Then 档位是 reduce_only（不是 halt），且任何标的都开不了新仓
    expect(result.state.level).toBe('reduce_only')
    expect(result.state.level).not.toBe('halt')
    expect(f.loop.openAllowed('BTC/USDT').allowed).toBe(false)
  })

  it('管理员：重连时产出 gap report 并写进 journal（恢复必须产出）', () => {
    // Given 一个跑过一轮的环路
    const f = fixture()
    f.loop.tickOnce()
    // When 重连
    const report = f.loop.onReconnect({ disconnectedFromMs: T0, reconnectedAtMs: T0 + 60_000 })
    // Then 报告有时长、且 journal 里有一条 gap.report（否则"产出过"无法证明）
    expect(report.disconnectedMs).toBe(60_000)
    const gapEvents = f.journal.read(0, 20).events.filter((event) => event.kind === 'gap.report')
    expect(gapEvents).toHaveLength(1)
    expect(f.loop.stats().gapReports).toBe(1)
  })

  it('管理员：start/stop 由调度器驱动，重复 start 不叠加链', async () => {
    // Given 启动两次
    const f = fixture({ alignmentOf: () => 'stale' })
    f.loop.start()
    f.loop.start()
    // When 调度器到点一次
    await f.clock.fire()
    // Then 只跑了一轮
    expect(f.loop.stats().ticks).toBe(1)
    // When 停掉
    f.loop.stop()
    await f.clock.fire()
    // Then 不再推进
    expect(f.loop.stats().running).toBe(false)
    expect(f.loop.stats().ticks).toBe(1)
  })

  it('管理员：环路每轮落心跳（dead-man 看门狗据此判断失活，不依赖问进程）', () => {
    // Given 一个带心跳路径的环路
    const dir = mkdtempSync(join(tmpdir(), 'desk-loop-hb-'))
    dirs.push(dir)
    const heartbeatPath = join(dir, 'heartbeat.json')
    const ledgers = openLedgers(dir)
    migrateDeskRecords(ledgers.orders)
    migrateTriggers(ledgers.orders)
    let tick = T0
    const journal = createJournal(ledgers.audit, { now: () => (tick += 1) })
    const clock = manualScheduler()
    const loop = createDeskLoop({
      orders: ledgers.orders,
      audit: ledgers.audit,
      journal,
      gate: { protectiveOrdersAtVenue: false },
      signals: () => ({
        symbols: ['BTC/USDT'],
        alignmentOf: () => 'aligned',
        lastHeartbeatAtMs: T0,
        heartbeatTimeoutMs: 30_000,
        venueErrorStreak: 0,
        venueErrorThreshold: 3,
        diskWriteFailed: false,
        now: () => (tick += 1),
      }),
      scheduler: clock.scheduler,
      now: () => (tick += 1),
      intervalMs: 1_000,
      heartbeatPath,
    })
    // When 跑一轮
    loop.tickOnce()
    // Then 心跳文件存在且内容可解析（原子写：不会留下半个 JSON）
    const beaten = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { atMs: number; note: string }
    expect(beaten.atMs).toBeGreaterThan(0)
    expect(beaten.note).toContain('desk tick 1')
  })
})
