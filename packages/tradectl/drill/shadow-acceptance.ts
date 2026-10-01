#!/usr/bin/env node
/**
 * P5 三档验收 · **第 1 档 shadow**（不碰钱：真实行情驱动决策与风控，不产生任何订单）。
 *
 * 与 desk-loop-live 的区别：那个是 15 秒的装配演练（证明链路通），这个是**验收跑**：
 *   - 跑够时长（默认 10 分钟，SHADOW_RUN_MS 可调）；
 *   - 记录落到**稳定目录**（.local/drills/shadow-<ts>/，gitignored），所以事后能查；
 *   - 结束时产出 JSON 记录（决策/过渡/对齐/gap/审计条数），供写验收记录用。
 *
 * 退出码即断言：任何一条关键判据不过 ⇒ 非 0。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAlignment, createStreamingFeed } from '../lib/index.js'
import { binanceStreamUrl, fetchBinanceSnapshot, parseBinanceFrame } from '../lib/adapters/binance.js'
import { createNodeWebSocketTransport } from '../lib/transport/node-ws.js'
import { openLedgers } from '../lib/db.js'
import { createJournal } from '../lib/journal.js'
import { migrateDeskRecords } from '../lib/desk-records.js'
import { migrateTriggers } from '../lib/triggers.js'
import { createDeskLoop } from '../lib/desk-loop.js'

const NL = String.fromCharCode(10)
const SYMBOL = 'BTC/USDT'
// 默认 30 秒：让**常设冒烟**能直接跑它（可反复复现第 1 档证据）；
// 正式验收跑用显式 env 拉长（2026-10-01 的入册记录用 SHADOW_RUN_MS=600000）。
const RUN_MS = Number(process.env.SHADOW_RUN_MS ?? 30_000)
const T0 = Date.now()
const stamp = new Date(T0).toISOString().replace(/[:.]/g, '-')
const home = join(process.cwd(), '.local', 'drills', 'shadow-' + stamp)
mkdirSync(home, { recursive: true })

const ledgers = openLedgers(home)
migrateDeskRecords(ledgers.orders)
migrateTriggers(ledgers.orders)
let tick = T0
const journal = createJournal(ledgers.audit, { now: () => (tick += 1) })

const alignment = createAlignment(
  {
    symbols: [SYMBOL],
    snapshotAgeBudgetMs: Math.max(60_000, RUN_MS),
    bufferMaxTicks: 10_000,
    bufferMaxBytes: 8 * 1024 * 1024,
    realignTokenCapacity: 5,
    realignRefillPerSec: 1,
    divergenceBps: 50,
    divergenceStrikes: 3,
    orderTokenCapacity: 3,
    orderRefillPerSec: 1,
  },
  T0,
)

const feed = createStreamingFeed({
  url: binanceStreamUrl([SYMBOL]),
  symbols: [],
  transport: createNodeWebSocketTransport(),
  sink: alignment,
  subscribePayload: () => '',
  decode: (text, epoch) => parseBinanceFrame(text, epoch),
  scheduler: { schedule: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) } },
  now: () => Date.now(),
  heartbeatTimeoutMs: 30_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 10_000,
  bootstrapSymbols: [SYMBOL],
  bootstrap: async (symbols) => Promise.all(symbols.map((s) => fetchBinanceSnapshot(s, 0))),
  maxBatch: 64,
})

const loop = createDeskLoop({
  orders: ledgers.orders,
  audit: ledgers.audit,
  journal,
  gate: { protectiveOrdersAtVenue: false },
  signals: () => ({
    symbols: [SYMBOL],
    alignmentOf: () => alignment.state(Date.now()).alignment,
    lastHeartbeatAtMs: feed.stats().lastMessageAtMs,
    heartbeatTimeoutMs: 60_000,
    venueErrorStreak: 0,
    venueErrorThreshold: 3,
    diskWriteFailed: false,
    clockDriftMs: 0,
    clockDriftToleranceMs: 1_000,
    now: () => Date.now(),
  }),
  scheduler: { schedule: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) } },
  now: () => Date.now(),
  intervalMs: 5_000,
  heartbeatPath: join(home, 'heartbeat.json'),
  probeDir: home,
})

const levels = []
const triggerTally = {}
feed.start()
loop.start()
const sampler = setInterval(() => {
  const result = loop.tickOnce()
  levels.push(result.state.level)
  for (const trigger of result.triggers) triggerTally[trigger] = (triggerTally[trigger] ?? 0) + 1
}, 5_000)

process.stdout.write('[shadow-acceptance] 第 1 档开始：' + String(RUN_MS / 1000) + ' 秒，home=' + home + NL)

setTimeout(() => {
  clearInterval(sampler)
  const stats = feed.stats()
  const alignmentState = alignment.state(Date.now())
  const gap = loop.onReconnect({ disconnectedFromMs: T0, reconnectedAtMs: Date.now() })
  const events = journal.read(0, 5_000).events
  const byKind = {}
  for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1
  const levelsSeen = [...new Set(levels)]
  const record = {
    tier: 'shadow',
    startedAt: new Date(T0).toISOString(),
    durationMs: Date.now() - T0,
    home,
    market: { messages: stats.messages, badFrames: stats.badFrames, ignoredFrames: stats.ignoredFrames, state: stats.state },
    alignment: { alignment: alignmentState.alignment, droppedTicks: alignmentState.droppedTicks },
    loop: { ticks: loop.stats().ticks, transitions: loop.stats().transitions, recordFailures: loop.stats().recordFailures, lastProbeReason: loop.stats().lastProbeReason },
    levelsSeen,
    triggerTally,
    gapReport: { disconnectedMs: gap.disconnectedMs },
    journal: { total: events.length, byKind },
    openAllowed: loop.openAllowed(SYMBOL),
  }
  writeFileSync(join(home, 'acceptance-record.json'), JSON.stringify(record, null, 2))
  process.stdout.write('[shadow-acceptance] ' + JSON.stringify(record, null, 1) + NL)
  loop.stop()
  feed.stop()
  const failures = []
  if (stats.messages === 0) failures.push('零行情消息')
  if (stats.badFrames > 0) failures.push('出现坏帧 ' + String(stats.badFrames))
  if (alignmentState.alignment !== 'aligned') failures.push('未保持 aligned：' + String(alignmentState.alignment))
  if (loop.stats().ticks === 0) failures.push('环路未运行')
  if (loop.stats().recordFailures > 0) failures.push('审计写入失败 ' + String(loop.stats().recordFailures))
  if (levelsSeen.includes('halt')) failures.push('出现了 halt（自动路径不得达 halt）')
  if (failures.length > 0) {
    process.stderr.write('[shadow-acceptance] ✗ ' + failures.join(' | ') + NL)
    process.exit(1)
  }
  process.stdout.write('[shadow-acceptance] ✓ 第 1 档通过（' + String(Math.round((Date.now() - T0) / 1000)) + ' 秒；档位集合 ' + JSON.stringify(levelsSeen) + '）' + NL)
  process.exit(0)
}, RUN_MS)
