#!/usr/bin/env node
/**
 * desk 环路装配演练（P5 步骤 1 的"装进进程"在不涉真钱下的最近一步）。
 *
 * 它证明什么：**整条链真的能一起跑**，并在真实数据库与真实 journal 上留下痕迹 ——
 * 信号 → 触发源 → 档位 → 风控状态 → 留痕 → 重连产 gap report。
 * 它不证明什么：**没有接真实 venue**（下单端口不存在），信号是脚本化的而非从真实行情检测器读的。
 *
 * 退出码即断言（同 a0-e2e / attach-drill 的做法）。
 *
 * **跨文件契约**：末行总结（[desk-loop-drill] ✓ 五幕 + 重连全部通过 …）被 scripts/e2e-smoke.mjs 断言。
 * 改这一行就要同批改那边的 expect —— 2026-10-01 就因为这个包报红才发现漏改。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedgers } from '../src/db.ts'
import { createJournal } from '../src/journal.ts'
import { migrateDeskRecords } from '../src/desk-records.ts'
import { migrateTriggers } from '../src/triggers.ts'
import { createDeskLoop } from '../src/desk-loop.ts'
import { createWatchdog } from '../src/watchdog.ts'
import type { MonitorSignals } from '../src/degradation-monitor.ts'

const T0 = 1_700_000_000_000
const NL = String.fromCharCode(10)

const home = mkdtempSync(join(tmpdir(), 'desk-loop-drill-'))
const failures: string[] = []
let tick = T0

const ledgers = openLedgers(home)
migrateDeskRecords(ledgers.orders)
migrateTriggers(ledgers.orders)
const journal = createJournal(ledgers.audit, { now: () => (tick += 1) })

// 脚本化信号：三幕 —— 健康 → 陈旧+心跳丢失 → 恢复
let phase: 'healthy' | 'degraded' | 'recovered' = 'healthy'
const alignment: Record<string, 'aligned' | 'stale'> = { 'BTC/USDT': 'aligned', 'ETH/USDT': 'aligned' }
let heartbeatAtMs = T0

const signals = (): MonitorSignals => ({
  symbols: ['BTC/USDT', 'ETH/USDT'],
  alignmentOf: (symbol) => alignment[symbol],
  lastHeartbeatAtMs: heartbeatAtMs,
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
  // 演练用同步推进：schedule 立刻记住回调，由脚本自己决定何时"到点"
  scheduler: { schedule: () => () => {} },
  now: () => (tick += 1),
  intervalMs: 1_000,
  // 环路自己产心跳：dead-man 第一层（快环看门狗）据此判断"bot 自己心跳失活"，
  // 而不是靠问进程或看手机连没连上（设计 §13 #19）。
  heartbeatPath: join(home, "heartbeat.json"),
})

const observe: string[] = []
const record = (label: string, level: string, transitions: number): void => {
  observe.push(label + ': level=' + level + ' transitions=' + transitions)
  process.stdout.write('  ' + label + ' → level=' + level + '（本轮留痕 ' + String(transitions) + ' 条）' + NL)
}

try {
  // 第一幕：健康
  const healthy = loop.tickOnce()
  record('第一幕 健康', healthy.state.level, healthy.transitions)
  if (healthy.state.level !== 'normal') failures.push('健康时档位应为 normal，实际 ' + healthy.state.level)

  // 第二幕：**只有** BTC 陈旧（单标的故障）—— 验 #24：不牵连全局、不连坐其他标的
  alignment['BTC/USDT'] = 'stale'
  phase = 'degraded'
  const symbolOnly = loop.tickOnce()
  record('第二幕 仅 BTC 陈旧（单标的）', symbolOnly.state.level, symbolOnly.transitions)
  if (symbolOnly.state.level !== 'normal') failures.push('单标的故障不该改全局档位（#24），实际 ' + symbolOnly.state.level)
  if (loop.openAllowed('BTC/USDT').allowed) failures.push('陈旧的 BTC/USDT 竟然还能开新仓')
  if (!loop.openAllowed('ETH/USDT').allowed) failures.push('ETH/USDT 是对齐的，被单标的故障连坐了（#24）')

  // 第三幕：再叠加**全局**故障（心跳丢失）—— 这时 desk 才该整体降为 reduce_only
  heartbeatAtMs = T0 - 99_999
  const global = loop.tickOnce()
  record('第三幕 叠加心跳丢失（全局）', global.state.level, global.transitions)
  if (global.state.level !== 'reduce_only') failures.push('全局故障后档位应为 reduce_only，实际 ' + global.state.level)
  if (global.state.level === 'halt') failures.push('自动路径产出了 halt —— 违反 #25')
  if (loop.openAllowed('ETH/USDT').allowed) failures.push('全局 reduce_only 下 ETH/USDT 不该还能开新仓')

  // 第四幕：恢复（自愈而非闩锁）
  alignment['BTC/USDT'] = 'aligned'
  heartbeatAtMs = T0
  phase = 'recovered'
  const recovered = loop.tickOnce()
  record('第四幕 恢复', recovered.state.level, recovered.transitions)
  if (recovered.state.level !== 'normal') failures.push('恢复后档位应为 normal，实际 ' + recovered.state.level)
  if (!loop.openAllowed('BTC/USDT').allowed) failures.push('恢复后 BTC/USDT 应可开新仓')

  // 重连：产出 gap report 并进 journal
  const report = loop.onReconnect({ disconnectedFromMs: T0, reconnectedAtMs: tick })
  process.stdout.write('  gap report → 断连 ' + String(report.disconnectedMs) + 'ms，错过触发 ' + String(report.missedTriggers.length) + '，降级动作 ' + String(report.degradationActions.length) + NL)
  if (loop.stats().gapReports !== 1) failures.push('重连未产出 gap report')

  // 账目核对
  const events = journal.read(0, 100).events
  const transitions = events.filter((event) => event.kind === 'degradation.transition')
  const gapReports = events.filter((event) => event.kind === 'gap.report')
  process.stdout.write('  journal → degradation.transition ' + String(transitions.length) + ' 条，gap.report ' + String(gapReports.length) + ' 条' + NL)
  if (transitions.length < 4) failures.push('降级过渡留痕不足 4 条（降下去与回来都要留痕），实际 ' + String(transitions.length))
  void phase
  if (gapReports.length !== 1) failures.push('journal 里没有 gap.report 事件')

  // 第五幕：dead-man 第一层 —— 快环看门狗（不依赖 agent 存活）
  const stales: string[] = []
  const recoveries: number[] = []
  const watchdog = createWatchdog({
    heartbeatPath: join(home, "heartbeat.json"),
    timeoutMs: 10_000,
    scheduler: { schedule: () => () => {} },
    now: () => tick,
    intervalMs: 1_000,
    onStale: (reason) => stales.push(reason),
    onRecovered: (silentMs) => recoveries.push(silentMs),
  })
  const fresh = watchdog.checkOnce()
  process.stdout.write("  第五幕 心跳新鲜 → " + JSON.stringify({ stale: fresh.stale, silentMs: fresh.silentMs }) + NL)
  if (fresh.stale) failures.push("环路刚跑过，看门狗却判失活")
  // 模拟 desk 死了：时钟推进 30 秒且不再有心跳
  tick += 30_000
  const dead = watchdog.checkOnce()
  watchdog.checkOnce()
  process.stdout.write("  第五幕 desk 停摆 → " + JSON.stringify({ stale: dead.stale, reason: dead.reason, 喊次数: stales.length }) + NL)
  if (!dead.stale) failures.push("心跳静默 30 秒（阈值 10 秒）却没判失活")
  if (stales.length !== 1) failures.push("一次失活应只喊一次，实际 " + String(stales.length) + " 次")
  // desk 回来：写一次心跳
  const loopAgain = loop.tickOnce()
  const back = watchdog.checkOnce()
  process.stdout.write("  第五幕 恢复 → " + JSON.stringify({ stale: back.stale, 恢复留痕: recoveries.length, 环路档位: loopAgain.state.level }) + NL)
  if (back.stale) failures.push("心跳已恢复却仍判失活")
  if (recoveries.length !== 1) failures.push("恢复没有留痕")

  // 复述判据：任何一条过渡都不能是 halt
  for (const event of transitions) {
    if ((event.payload as { to?: string }).to === 'halt') failures.push('journal 里出现了 halt 过渡：' + JSON.stringify(event.payload))
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write('[desk-loop-drill] ✗ ' + String(failures.length) + ' 项断言失败：' + NL)
  for (const failure of failures) process.stderr.write('  - ' + failure + NL)
  process.exit(1)
}
process.stdout.write('[desk-loop-drill] ✓ 五幕 + 重连全部通过（#24 单标的不连坐、#25 全局封顶且无 halt、恢复自愈、gap report 齐全、dead-man 第一层看门狗生效且只喊一次）' + NL)
process.exit(0)
