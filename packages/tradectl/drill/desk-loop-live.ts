#!/usr/bin/env node
/**
 * 环路 + **真实行情**（P5 步骤 1 里"真实检测器"的行情侧，不涉真钱）。
 * 与 desk-loop-drill 的分工：那个用脚本化信号验不变量；这个把 Binance 公共流的真实对齐态喂进环路。
 * 退出码即断言；需要网络。
 *
 * 2026-10-01 记：第一版跑不通（对齐层恒 stale），根因是**参数名写错** —— 用了 snapshotMaxAgeMs
 * 而真名是 snapshotAgeBudgetMs ⇒ 预算 undefined ⇒ 每一帧都被判陈旧。drills 不在 tsc 范围内，
 * 这类错误当时没在编译期暴露；现在 createAlignment 有参数守卫会直接抛错。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const RUN_MS = 15_000
const T0 = Date.now()

const home = mkdtempSync(join(tmpdir(), 'desk-loop-live-'))
const ledgers = openLedgers(home)
migrateDeskRecords(ledgers.orders)
migrateTriggers(ledgers.orders)
const journal = createJournal(ledgers.audit, { now: () => Date.now() })

const alignment = createAlignment(
  {
    symbols: [SYMBOL],
    snapshotAgeBudgetMs: 60_000,
    bufferMaxTicks: 1_000,
    bufferMaxBytes: 1_048_576,
    realignTokenCapacity: 3,
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
  scheduler: {
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
  },
  now: () => Date.now(),
  heartbeatTimeoutMs: 30_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 5_000,
  bootstrapSymbols: [SYMBOL],
  bootstrap: async (symbols) => Promise.all(symbols.map((symbol) => fetchBinanceSnapshot(symbol, 0))),
  maxBatch: 64,
})

const loop = createDeskLoop({
  orders: ledgers.orders,
  audit: ledgers.audit,
  journal,
  gate: { protectiveOrdersAtVenue: false },
  signals: () => ({
    symbols: [SYMBOL],
    alignmentOf: (symbol) => (symbol === SYMBOL ? (alignment.state(Date.now()).alignment as 'aligned' | 'unaligned' | 'stale') : undefined),
    lastHeartbeatAtMs: feed.stats().lastMessageAtMs,
    heartbeatTimeoutMs: 30_000,
    venueErrorStreak: 0,
    venueErrorThreshold: 3,
    diskWriteFailed: false,
    now: () => Date.now(),
  }),
  scheduler: {
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
  },
  now: () => Date.now(),
  intervalMs: 1_500,
})

const failures: string[] = []
const triggerLog: string[] = []
feed.start()
loop.start()
const sampler = setInterval(() => {
  const result = loop.tickOnce()
  triggerLog.push(result.triggers.join(',') + '@' + result.state.level)
}, 1_500)
process.stdout.write('[desk-loop-live] 真实行情接入中（' + String(RUN_MS / 1000) + ' 秒）…' + NL)

setTimeout(() => {
  try {
    clearInterval(sampler)
    const stats = feed.stats()
    const alignmentState = alignment.state(Date.now())
    const report = loop.onReconnect({ disconnectedFromMs: T0, reconnectedAtMs: Date.now() })
    const events = journal.read(0, 200).events
    const gapReports = events.filter((event) => event.kind === 'gap.report')

    process.stdout.write('  行情统计: ' + JSON.stringify({ messages: stats.messages, badFrames: stats.badFrames, ignoredFrames: stats.ignoredFrames, state: stats.state }) + NL)
    process.stdout.write('  对齐态: ' + JSON.stringify({ alignment: alignmentState.alignment, droppedTicks: alignmentState.droppedTicks }) + NL)
    process.stdout.write('  环路: ticks=' + String(loop.stats().ticks) + ' transitions=' + String(loop.stats().transitions) + NL)
    process.stdout.write('  逐轮: ' + triggerLog.join(' | ') + NL)
    process.stdout.write('  开仓判定: ' + JSON.stringify(loop.openAllowed(SYMBOL)) + NL)
    process.stdout.write('  gap report: 断连 ' + String(report.disconnectedMs) + 'ms，journal gap.report ' + String(gapReports.length) + ' 条' + NL)

    if (stats.messages === 0) failures.push('一条行情消息都没收到')
    if (stats.badFrames > 0) failures.push('出现坏帧：' + String(stats.badFrames))
    if (loop.stats().ticks === 0) failures.push('环路一次都没跑')
    if (alignmentState.alignment !== 'aligned') failures.push('真实行情未达到 aligned：' + String(alignmentState.alignment))
    if (gapReports.length !== 1) failures.push('重连未把 gap report 写进 journal')
  } finally {
    loop.stop()
    feed.stop()
    rmSync(home, { recursive: true, force: true })
  }
  if (failures.length > 0) {
    process.stderr.write('[desk-loop-live] ✗ ' + failures.join(' | ') + NL)
    process.exit(1)
  }
  process.stdout.write('[desk-loop-live] ✓ 真实行情驱动环路：对齐达成、档位合法、gap report 已留痕' + NL)
  process.exit(0)
}, RUN_MS)
