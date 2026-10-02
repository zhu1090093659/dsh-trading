#!/usr/bin/env node
/**
 * desk 进程装配演练（P5 步骤 1 的"装进进程"在不涉真钱下的最近一步）。
 *
 * 它证明什么：**环路与事件泵真的在同一个进程里一起跑**，并且在真实数据库与真实 journal 上留下痕迹 ——
 *   环路按 interval 推进（心跳、信号、档位）；
 *   泵按 interval 推进（到点 → dry-run 派发 → 记账 → 排下一次）；
 *   停机积压超阈值时积压告警**写进审计**（runbook「待接线」第一件事）；
 *   未知选项（venue 下单端口）与非 dry-run 模式**当场被拒**（装配里没有下单路径）；
 *   stop 之后两者都不再推进。
 * 它不证明什么：**没有接真实 venue**（下单端口不存在）、没有真实行情（信号是脚本化的）、
 * 没有长期值守（默认 4 秒）。
 *
 * 退出码即断言（同 desk-loop-drill 的做法）。**跨文件契约**：末行总结（[desk-process-shadow] ✓ …）
 * 被 scripts/e2e-smoke.mjs 断言 —— 改这一行就要同批改那边的 expect。
 *
 * 环境变量：DESK_PROCESS_RUN_MS 覆盖运行时长（毫秒，默认 4000）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as waitMs } from 'node:timers/promises'
import { openLedgers } from '../src/db.ts'
import { createJournal } from '../src/journal.ts'
import { migrateDeskRecords } from '../src/desk-records.ts'
import { addSchedule, migrateTriggers } from '../src/triggers.ts'
import { createDeskProcess, type DeskProcessOptions } from '../src/desk-process.ts'

const NL = String.fromCharCode(10)
const RUN_MS = Number(process.env.DESK_PROCESS_RUN_MS ?? 4_000)
const INTERVAL_MS = 500
const BACKLOG_THRESHOLD = 3
const T0 = Date.now()

const home = mkdtempSync(join(tmpdir(), 'desk-process-shadow-'))
const ledgers = openLedgers(home)
migrateDeskRecords(ledgers.orders)
migrateTriggers(ledgers.orders)
const journal = createJournal(ledgers.audit, { now: () => Date.now() })

// 三条调度：一条**积压**（模拟停机后补发，用来验积压告警写审计），两条正常到点。
addSchedule(ledgers.orders, { id: 'catch-up', intervalMs: 1_000, atMs: null, nextAtMs: T0 - 5_000, enabled: true, kind: 'risk-check' })
addSchedule(ledgers.orders, { id: 'wake', intervalMs: 1_000, atMs: null, nextAtMs: T0 + 1_000, enabled: true, kind: 'wake' })
addSchedule(ledgers.orders, { id: 'rebalance', intervalMs: 2_000, atMs: null, nextAtMs: T0 + 2_000, enabled: true, kind: 'rebalance' })

const options: DeskProcessOptions = {
  orders: ledgers.orders,
  audit: ledgers.audit,
  journal,
  gate: { protectiveOrdersAtVenue: false },
  signals: () => ({
    symbols: ['BTC/USDT', 'ETH/USDT'],
    alignmentOf: () => 'aligned',
    lastHeartbeatAtMs: Date.now(),
    heartbeatTimeoutMs: 30_000,
    venueErrorStreak: 0,
    venueErrorThreshold: 3,
    diskWriteFailed: false,
    now: () => Date.now(),
  }),
  // 真实调度器与真实时钟（演练就是要跑真的一遍）
  scheduler: {
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
  },
  now: () => Date.now(),
  intervalMs: INTERVAL_MS,
  deskSessionId: 'desk-shadow-drill',
  backlogWarnThreshold: BACKLOG_THRESHOLD,
  heartbeatPath: join(home, 'heartbeat.json'),
}

const failures: string[] = []
const desk = createDeskProcess(options)

try {
  process.stdout.write('[desk-process-shadow] 进程装配启动（' + String(RUN_MS / 1000) + ' 秒，环路与泵间隔 ' + String(INTERVAL_MS) + 'ms）…' + NL)
  desk.start()
  await waitMs(RUN_MS)
  const running = desk.stats()
  desk.stop()
  // 先让在途的那一轮落地，再取停后基线；然后等两个间隔看是否还动
  await waitMs(INTERVAL_MS + 200)
  const stoppedA = desk.stats()
  await waitMs(INTERVAL_MS * 2)
  const stoppedB = desk.stats()

  // 灯下黑检查：装配不接受任何下单端口，也不接受未实现的 live 模式
  let rejectedVenue = false
  try {
    createDeskProcess({ ...options, venue: { placeOrder: () => undefined } } as unknown as DeskProcessOptions)
  } catch {
    rejectedVenue = true
  }
  let rejectedLive = false
  try {
    createDeskProcess({ ...options, dispatchMode: 'live' } as unknown as DeskProcessOptions)
  } catch {
    rejectedLive = true
  }

  const events = journal.read(0, 500).events
  const backlogRows = events.filter((event) => event.kind === 'trigger.backlog')
  const dispatchRows = events.filter((event) => event.kind === 'trigger.dispatch.dry-run')
  const gapRows = events.filter((event) => event.kind === 'gap.report')
  const dueTotal = dispatchRows.reduce((sum, row) => sum + Number((row.payload as { count?: number }).count ?? 0), 0)

  process.stdout.write('  统计: ' + JSON.stringify({
    mode: running.mode,
    loopTicks: running.loop.ticks,
    loopTransitions: running.loop.transitions,
    loopRecordFailures: running.loop.recordFailures,
    pumpTicks: running.pump.ticks,
    dispatched: running.pump.dispatched,
    failed: running.pump.failed,
    dryRunCalls: running.dryRun.calls,
    dryRunOccurrences: running.dryRun.occurrences,
    backlogWarnings: running.backlog.warnings,
  }) + NL)
  process.stdout.write('  审计: ' + JSON.stringify({
    'trigger.backlog': backlogRows.length,
    'trigger.dispatch.dry-run': dispatchRows.length,
    '本会派发的 due 条数': dueTotal,
    'gap.report': gapRows.length,
  }) + NL)
  process.stdout.write('  stop 之后: ' + JSON.stringify({
    loopTicks: stoppedA.loop.ticks + '→' + stoppedB.loop.ticks,
    pumpTicks: stoppedA.pump.ticks + '→' + stoppedB.pump.ticks,
    running: stoppedB.running,
  }) + NL)
  process.stdout.write('  fail-closed: ' + JSON.stringify({ 'venue 端口被拒': rejectedVenue, 'live 模式被拒': rejectedLive }) + NL)

  // —— 断言 ——
  if (running.mode !== 'dry-run') failures.push('装配不是 dry-run：' + String(running.mode))
  if (running.loop.ticks === 0) failures.push('环路一次都没跑')
  if (running.pump.ticks === 0) failures.push('事件泵一次都没跑')
  if (running.pump.dispatched === 0) failures.push('泵一次都没派发（到点判定或调度推进有问题）')
  if (running.dryRun.occurrences !== running.pump.dispatched) failures.push('dry-run 记账与泵统计不一致：' + String(running.dryRun.occurrences) + ' vs ' + String(running.pump.dispatched))
  if (running.dryRun.failures !== 0) failures.push('出现了派发失败：' + String(running.dryRun.lastError))
  if (dispatchRows.length === 0) failures.push('审计里没有 trigger.dispatch.dry-run 记录')
  if (dueTotal !== running.pump.dispatched) failures.push('审计里的 due 条数与泵统计不一致：' + String(dueTotal) + ' vs ' + String(running.pump.dispatched))
  if (running.backlog.warnings < 1) failures.push('积压超过阈值（' + String(BACKLOG_THRESHOLD) + '）却没有告警')
  if (running.backlog.recordFailures !== 0) failures.push('积压告警没能留痕：' + String(running.backlog.recordFailures))
  if (backlogRows.length < 1) failures.push('审计里没有 trigger.backlog 记录')
  if (!rejectedVenue) failures.push('未知选项（venue 下单端口）没有被拒绝 —— fail-closed 失效')
  if (!rejectedLive) failures.push('未实现的 live 模式没有被拒绝 —— fail-closed 失效')
  if (stoppedB.loop.ticks !== stoppedA.loop.ticks) failures.push('stop 之后环路仍在推进：' + String(stoppedA.loop.ticks) + '→' + String(stoppedB.loop.ticks))
  if (stoppedB.pump.ticks !== stoppedA.pump.ticks) failures.push('stop 之后泵仍在推进：' + String(stoppedA.pump.ticks) + '→' + String(stoppedB.pump.ticks))
} finally {
  desk.stop()
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write('[desk-process-shadow] ✗ ' + String(failures.length) + ' 项断言失败：' + NL)
  for (const failure of failures) process.stderr.write('  - ' + failure + NL)
  process.exit(1)
}
process.stdout.write('[desk-process-shadow] ✓ 进程装配通过：环路与事件泵按 interval 同跑、dry-run 派发只记录意图（无下单路径、非 dry-run 模式被拒）、积压告警已落审计、stop 后不再推进' + NL)
process.exit(0)
