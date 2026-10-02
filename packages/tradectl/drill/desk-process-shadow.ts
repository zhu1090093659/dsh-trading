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
import { createAlignment } from '../src/alignment.ts'
import { openLedgers } from '../src/db.ts'
import { createJournal } from '../src/journal.ts'
import { migrateDeskRecords } from '../src/desk-records.ts'
import { addSchedule, migrateTriggers } from '../src/triggers.ts'
import { createDeskProcess, type DeskProcessOptions } from '../src/desk-process.ts'
import { createCountingVenue } from '../src/shadow.ts'
import { DRILL_ALIGNMENT_PARAMS, DRILL_ALIGNMENT_PARAMS_NOTE, SNAPSHOT_REFRESH_MS } from './alignment-params.ts'

const NL = String.fromCharCode(10)
const RUN_MS = Number(process.env.DESK_PROCESS_RUN_MS ?? 4_000)
const INTERVAL_MS = 500
const BACKLOG_THRESHOLD = 3
const T0 = Date.now()

/** 演练盯的两只标的：一只**有基准快照**、一只**只有 tick 从无快照**（两种真实状态）。 */
const SYMBOLS = ['BTC/USDT', 'ETH/USDT'] as const
const [FED_SYMBOL, UNFED_SYMBOL] = SYMBOLS

/**
 * 对齐态来自**真实的对齐状态机**，不是常量。
 *
 * 修前这里是 `alignmentOf: () => 'aligned'`（2026-10-02 验收发现 F6）：一个恒为 aligned 的
 * 输入让"降级链真的会动"在演练里**不可证伪** —— 跑绿只说明"没事发生"，而没事发生既可能是
 * "系统健康"，也可能是"信号从来没接上"。演练里出现"永远 aligned"等于把这条断言变成装饰。
 *
 * 现在按标的喂两种真实状态（同一个状态机、同一份未标定参数来源）：
 *   - BTC/USDT：有 epoch 1 的基准快照 ⇒ aligned；
 *   - ETH/USDT：只有 tick、从无基准 ⇒ unaligned（`alignment.ts` 对"从未见过"的标的就是这个态）。
 * 于是"对齐态流进环路"这件事可以被审计记录证伪：ETH 必须产生一条 market-stale 降级。
 */
const alignment = createAlignment(DRILL_ALIGNMENT_PARAMS, T0)
alignment.onSnapshot({ epoch: 1, symbol: FED_SYMBOL, price: 83_000, atMs: T0 }, T0)
alignment.onTick({ epoch: 1, symbol: UNFED_SYMBOL, price: 3_100, atMs: T0, seq: 1 }, T0)
const alignmentOf = (symbol: string): 'aligned' | 'unaligned' | 'stale' => alignment.state(Date.now(), symbol).alignment

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
    symbols: SYMBOLS,
    // 真实状态机的逐标的读数（不是常量）：见上面 alignmentOf 的说明
    alignmentOf,
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

  // 灯下黑检查：装配不接受任何下单端口，也不接受未实现的 live 模式。
  // 探针用 shadow 装置的**计数假 venue**（%%createCountingVenue%%）而不是内联字面量：
  // "被拒"与"一次都没被调用"是两件事 —— 前者只看抛错，后者才证明拒绝之后没有留下任何下单路径。
  const probeVenue = createCountingVenue()
  let rejectedVenue = false
  try {
    createDeskProcess({ ...options, venue: probeVenue } as unknown as DeskProcessOptions)
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
  const degradationRows = events.filter((event) => event.kind === 'degradation.transition')
  // 未喂快照的那只标的必须产生一条 market-stale：这是"真实对齐态真的流进了环路"的**证据**，
  // 不是"跑完没报错"。恒为 aligned 的假信号下这一条必然是空的（修前就是这样）。
  const staleRows = degradationRows.filter((event) => {
    const payload = event.payload as { trigger?: string; reason?: string }
    return payload.trigger === 'market-stale' && String(payload.reason ?? '').includes(UNFED_SYMBOL)
  })
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
  process.stdout.write('  fail-closed: ' + JSON.stringify({
    'venue 端口被拒': rejectedVenue,
    'live 模式被拒': rejectedLive,
    'venue 探针被调用次数': probeVenue.calls,
  }) + NL)
  // 对齐输入**逐标的**打出来：这一行是"信号不是常量"的现场记录（常量不会给出两个不同的值）
  process.stdout.write('  对齐输入: ' + JSON.stringify({
    [FED_SYMBOL]: alignmentOf(FED_SYMBOL),
    [UNFED_SYMBOL]: alignmentOf(UNFED_SYMBOL),
    快照节奏ms: SNAPSHOT_REFRESH_MS,
    参数来源: DRILL_ALIGNMENT_PARAMS_NOTE,
  }) + NL)
  process.stdout.write('  降级记录: ' + JSON.stringify({
    'degradation.transition 总数': degradationRows.length,
    'market-stale（未对齐标的）': staleRows.length,
    '命中标的': staleRows.map((row) => String((row.payload as { reason?: string }).reason)),
  }) + NL)

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
  // —— 对齐输入必须是真的（2026-10-02 验收发现 F6：这里曾经是 `() => 'aligned'`）——
  if (alignmentOf(FED_SYMBOL) !== 'aligned') failures.push('有基准快照的 ' + FED_SYMBOL + ' 不是 aligned：' + alignmentOf(FED_SYMBOL))
  if (alignmentOf(UNFED_SYMBOL) === 'aligned') failures.push('从无基准快照的 ' + UNFED_SYMBOL + ' 却报 aligned —— 对齐输入又变成常量了')
  if (degradationRows.length === 0) failures.push('审计里一条 degradation.transition 都没有：真实对齐态没有流进环路')
  if (staleRows.length === 0) failures.push('未喂快照的 ' + UNFED_SYMBOL + ' 没有产生 market-stale 降级记录 —— 对齐输入可能还是常量')
  if (!rejectedVenue) failures.push('未知选项（venue 下单端口）没有被拒绝 —— fail-closed 失效')
  // 计数假 venue 的调用次数：拒绝必须发生在**碰它之前**（0 才算"没有下单路径"）
  if (probeVenue.calls !== 0) failures.push('计数假 venue 被调用了 ' + String(probeVenue.calls) + ' 次 —— 装配拒绝之前先碰了下单端口')
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
