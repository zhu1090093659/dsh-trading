/**
 * desk 进程装配测试（P5 步骤 1）：真 node:sqlite + 真 journal + 注入调度器与时钟 ⇒ 无 sleep、无 mock 框架。
 *
 * 它钉住四件被 runbook 点名的接线事实：
 *   1. **dry-run 是唯一被实现的派发语义**，且装配**不接受任何下单端口**（未知选项当场抛错，§13 #4「未知即放宽」）；
 *   2. **环路与事件泵在同一个调度器上按 interval 推进**，stop 之后都不再推进；
 *   3. **积压告警写审计**（runbook「待接线」第一件事）：超阈值 ⇒ 一次告警一条 trigger.backlog；
 *   4. **派发条数与泵自己的记账一致**；审计写不进去时派发**不计成功**（失败留痕，不静默当成已派发）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers } from '../src/db.ts'
import { createJournal } from '../src/journal.ts'
import { migrateDeskRecords } from '../src/desk-records.ts'
import { addSchedule, migrateTriggers } from '../src/triggers.ts'
import { createDeskProcess, type DeskProcessOptions } from '../src/desk-process.ts'
import type { LoopScheduler } from '../src/desk-loop.ts'
import type { MonitorSignals } from '../src/degradation-monitor.ts'

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 可手工推进的调度器：把"等 N 毫秒"变成"取出回调来跑"（与环路/泵的测试同款）。 */
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
    /** 跑一轮已排的回调（模拟时间到点），并让泵的异步重排落地。 */
    async fire(): Promise<void> {
      for (const entry of pending.splice(0)) if (!entry.cancelled) entry.callback()
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

function fixture(setup: { readonly nextAtMs?: number; readonly intervalMs?: number; readonly backlogWarnThreshold?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'desk-process-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  migrateDeskRecords(ledgers.orders)
  migrateTriggers(ledgers.orders)
  let nowMs = NOW
  const journal = createJournal(ledgers.audit, { now: () => nowMs })
  const clock = manualScheduler()
  addSchedule(ledgers.orders, {
    id: 'wake',
    intervalMs: setup.intervalMs ?? 5_000,
    atMs: null,
    nextAtMs: setup.nextAtMs ?? NOW,
    enabled: true,
    kind: 'wake',
  })
  const signals = (): MonitorSignals => ({
    symbols: ['BTC/USDT'],
    alignmentOf: () => 'aligned',
    lastHeartbeatAtMs: nowMs,
    heartbeatTimeoutMs: 30_000,
    venueErrorStreak: 0,
    venueErrorThreshold: 3,
    diskWriteFailed: false,
    now: () => nowMs,
  })
  const processOptions: DeskProcessOptions = {
    orders: ledgers.orders,
    audit: ledgers.audit,
    journal,
    gate: { protectiveOrdersAtVenue: false },
    signals,
    scheduler: clock.scheduler,
    now: () => nowMs,
    intervalMs: 1_000,
    deskSessionId: 'desk-1',
    backlogWarnThreshold: setup.backlogWarnThreshold,
  }
  const desk = createDeskProcess(processOptions)
  return {
    ledgers,
    journal,
    clock,
    desk,
    processOptions,
    /** 推进注入时钟（测试不许 sleep，时间由测试掌控）。 */
    advanceNow: (ms: number) => {
      nowMs += ms
    },
    events: () => journal.read(0, 100).events,
  }
}

describe('desk 进程装配', () => {
  it('管理员：装配默认 dry-run，且未知选项（venue 下单端口）与非 dry-run 模式都被当场拒绝', () => {
    // Given 一套真实库与一份最小选项
    const f = fixture()
    // Then 默认模式就是 dry-run（不需要任何显式授权，也就没有任何下单路径）
    expect(f.desk.stats().mode).toBe('dry-run')
    // When 试着把 venue 下单端口塞进装配
    const withVenue = { ...f.processOptions, venue: { placeOrder: () => undefined } }
    // Then 直接抛错：未知即放宽，白名单里没有任何键能承载下单能力
    expect(() => createDeskProcess(withVenue as unknown as DeskProcessOptions)).toThrow(/未知选项 venue/)
    // When 试着请求未实现的 live 模式
    const withLive = { ...f.processOptions, dispatchMode: 'live' }
    // Then 也直接抛错（宁可不启动，也不许静默降级或假装在跑实盘）
    expect(() => createDeskProcess(withLive as unknown as DeskProcessOptions)).toThrow(/只实现了 dry-run/)
  })

  it('管理员：环境变量写着关掉 dry-run 也不改变行为（装配不读环境变量）', async () => {
    // Given 三个"看起来像开关"的环境变量（都不是本仓的授权机制——权威是 authority:sign 签署 + live-trading:check 门禁）
    const decoys: Record<string, string> = { DRY_RUN: '0', LIVE_TRADING: 'true', OKX_LIVE: '1' }
    const saved = new Map(Object.keys(decoys).map((key) => [key, process.env[key]] as const))
    for (const [key, value] of Object.entries(decoys)) process.env[key] = value
    try {
      // When 在这一环境下装配并真的派发一次
      const f = fixture()
      f.desk.start()
      await f.clock.fire()
      // Then 仍是 dry-run：模式未变、审计里明写 mode=dry-run、派发条数照常记
      expect(f.desk.stats().mode).toBe('dry-run')
      expect(f.desk.stats().dryRun.occurrences).toBe(1)
      const dispatched = f.events().filter((event) => event.kind === 'trigger.dispatch.dry-run')
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]?.payload).toMatchObject({ mode: 'dry-run' })
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('管理员：start 后环路与事件泵各按 interval 推进，stop 之后都不再推进', async () => {
    // Given 一个到点的调度与已启动的进程
    const f = fixture()
    f.desk.start()
    // When 调度器到点
    await f.clock.fire()
    // Then 环路与泵各推进一轮，且泵真的派发了一条
    expect(f.desk.stats().loop.ticks).toBe(1)
    expect(f.desk.stats().pump.ticks).toBe(1)
    expect(f.desk.stats().pump.dispatched).toBe(1)
    // When 再让调度器到点一次
    await f.clock.fire()
    // Then 两者都继续推进（只有一条链活着的话，这里会立刻不一致）
    expect(f.desk.stats().loop.ticks).toBe(2)
    expect(f.desk.stats().pump.ticks).toBe(2)
    // When 停掉之后再让调度器到点
    f.desk.stop()
    await f.clock.fire()
    // Then 都不再推进
    expect(f.desk.stats().running).toBe(false)
    expect(f.desk.stats().loop.ticks).toBe(2)
    expect(f.desk.stats().pump.ticks).toBe(2)
  })

  it('管理员：dry-run 派发把意图写进审计，条数与泵的记账一致', async () => {
    // Given 一个正好到点（未错过）的调度与已启动的进程
    const f = fixture({ nextAtMs: NOW })
    f.desk.start()
    // When 调度器到点
    await f.clock.fire()
    // Then 派发条数与泵的记账一致（dispatched 是泵自己数的触发条数）
    const stats = f.desk.stats()
    expect(stats.pump.dispatched).toBe(1)
    expect(stats.pump.failed).toBe(0)
    expect(stats.dryRun.calls).toBe(1)
    expect(stats.dryRun.occurrences).toBe(stats.pump.dispatched)
    expect(stats.dryRun.failures).toBe(0)
    expect(stats.dryRun.lastAtMs).toBe(NOW)
    // Then 审计里有一条 dry-run 记录，内容足以重建"本会派发什么"（§13 #26）
    const rows = f.events().filter((event) => event.kind === 'trigger.dispatch.dry-run')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.atMs).toBe(NOW)
    expect(rows[0]?.payload).toEqual({
      mode: 'dry-run',
      deskSessionId: 'desk-1',
      count: 1,
      reduceOnly: false,
      occurrences: [{ scheduleId: 'wake', kind: 'wake', dueAtMs: NOW, missed: false }],
    })
  })

  it('管理员：积压超阈值时告警一次并写进审计（派发语义不变）', async () => {
    // Given 一条落后 5 个间隔（间隔 1 秒）的调度与阈值 3 —— 停机补发的规模必须可见
    const f = fixture({ nextAtMs: NOW - 5_000, intervalMs: 1_000, backlogWarnThreshold: 3 })
    f.desk.start()
    // When 调度器到点
    await f.clock.fire()
    // Then 补发 6 条（NOW-5000 … NOW）、告警一次、留痕一条，且告警不改变派发语义（仍是一次扇出）
    const stats = f.desk.stats()
    expect(stats.pump.dispatched).toBe(6)
    expect(stats.backlog.warnings).toBe(1)
    expect(stats.backlog.lastDue).toBe(6)
    expect(stats.backlog.lastAtMs).toBe(NOW)
    expect(stats.backlog.recordFailures).toBe(0)
    expect(stats.dryRun.calls).toBe(1)
    const warnings = f.events().filter((event) => event.kind === 'trigger.backlog')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.payload).toEqual({ due: 6, atMs: NOW, deskSessionId: 'desk-1' })
    // Then 补发的一批按"迟到触发只能减风险"记录（§13 #20）
    const dispatched = f.events().filter((event) => event.kind === 'trigger.dispatch.dry-run')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.payload).toMatchObject({ count: 6, reduceOnly: true })
    // When 再推一轮（排期已推进到未来）
    await f.clock.fire()
    // Then 不再重复告警（一次积压一条记录，不刷屏）
    expect(f.desk.stats().backlog.warnings).toBe(1)
    expect(f.events().filter((event) => event.kind === 'trigger.backlog')).toHaveLength(1)
  })

  it('管理员：审计写不进去时派发不计成功、积压告警也不打死进程（两者都可见）', async () => {
    // Given 一条积压的调度与一个坏掉的审计库（journal 表被删）
    const f = fixture({ nextAtMs: NOW - 5_000, intervalMs: 1_000, backlogWarnThreshold: 3 })
    f.ledgers.audit.exec('DROP TABLE journal')
    f.desk.start()
    // When 调度器到点
    await f.clock.fire()
    // Then 派发失败交给泵记 failed（不静默当成已派发），dry-run 记账如实为 0 条
    const stats = f.desk.stats()
    expect(stats.pump.dispatched).toBe(0)
    expect(stats.pump.failed).toBe(6)
    expect(stats.dryRun.calls).toBe(1)
    expect(stats.dryRun.occurrences).toBe(0)
    expect(stats.dryRun.failures).toBe(1)
    expect(stats.dryRun.lastError).toContain('journal')
    // Then 积压告警照发，但留痕失败被计数而不是抛出去打死进程
    expect(stats.backlog.warnings).toBe(1)
    expect(stats.backlog.recordFailures).toBe(1)
    // Then 失败在 orders 库的 occurrence 上留痕（不静默消失）
    const failed = f.ledgers.orders.prepare("SELECT COUNT(*) AS n FROM occurrences WHERE status = 'failed'").get() as { n: number }
    expect(Number(failed.n)).toBe(6)
  })

  it('管理员：重连产出 gap report 并写进 journal（#19 恢复必须产出）', () => {
    // Given 一个装配好的进程
    const f = fixture()
    // When 上报一次重连
    const report = f.desk.onReconnect({ disconnectedFromMs: NOW - 60_000, reconnectedAtMs: NOW })
    // Then 报告产出、写进 journal、统计可见
    expect(report.disconnectedMs).toBe(60_000)
    expect(f.desk.stats().loop.gapReports).toBe(1)
    const rows = f.events().filter((event) => event.kind === 'gap.report')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.atMs).toBe(NOW)
  })
})
