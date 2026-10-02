#!/usr/bin/env node
/**
 * 行情对齐三个上界参数的**标定入口**（设计 §3 参数标定门禁 / §13 不变量 #23）。
 *
 * 跑法（离线、确定性、无网络、无 sleep）：
 *
 *     node packages/tradectl/drill/calibrate-alignment.ts
 *
 * 为什么有这个文件：\`AlignmentParams\` 的三个上界（快照年龄预算、缓冲全局条数/字节、
 * 重对齐令牌桶容量）**不许拍脑袋写**，必须先在可注入五种故障的录音-回放 harness 上
 * 测出来。历史上同一组语义参数被写成 7 套互不相同的猜测值（年龄 5/10/12/15/60s+、
 * 条数 64/512/1000/2048/4096/10000），没有任何标定记录。本文件是那份记录的可执行
 * 版本：跑一次、出三组实测与上下档边界，\`alignment-params.ts\` 里的每个数字都能
 * 在这里找到出处（\`test/alignment-params.test.ts\` 逐条断言两者一致）。
 *
 * 三组测量与它们的判据（判定"档位"的两侧失效）：
 *
 *   ① 快照年龄：健康路径（周期刷新 + 到达抖动）下每条 tick 的快照年龄 p50/p99/max
 *      ⇒ 年龄预算。下侧失效 = 正常行情被误丢（健康路径出现 snapshot-stale），
 *      上侧失效 = 该丢的没丢（快照已死的标的多发了多少条 tick）。
 *   ② 缓冲条数/字节：断供窗口内每标的与**全局**的缓冲峰值 ⇒ 全局界。
 *      下侧失效 = 缓冲越界被整块清空（真实 tick 丢在界里），上侧 = 内存无界。
 *   ③ 重对齐令牌桶：重连/epoch 变更风暴下的请求需求（一个回填窗口内的峰值）
 *      ⇒ 容量。下侧失效 = 合法重对齐被误拒（永远回不到 aligned），
 *      上侧失效 = 失控重试环不再被抑制。
 *
 * 每一步的输入都有出处（见 INPUTS），没有"为了让这次跑绿"的数。
 *
 * 直接跑（node packages/tradectl/drill/calibrate-alignment.ts）出报告；被 import
 * 时不执行（标定测试要 import 它逐条对账）。
 *
 * @module @dshtrading/tractl/drill/calibrate-alignment
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { peakDemandInWindow, runMultiSymbolScenario, runScenario, summarizeAgeSamples, type AlignmentParams, type HarnessScenario, type MultiSymbolFeed, type MultiSymbolScenario } from '../src/replay-harness.ts'
import { SNAPSHOT_REFRESH_MS } from './alignment-params.ts'

const NL = String.fromCharCode(10)

/** 余量倍数：与 harness 的 \`calibrate\` 同一个口径（实测最大值 × 1.5）。 */
export const HEADROOM = 1.5

/** 标定场景的标的集合（4 只：够出"每标的 vs 全局"的对照，又不至于把回放跑成分钟级）。 */
export const CALIBRATION_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'] as const

/**
 * 输入与出处。**标定不是"没有假设"**——是把假设写下来、让它可被替换；
 * 换行情源/换交易所时先改这里，再重跑。
 */
export const INPUTS = {
  /** 基准快照的周期刷新节奏：drill 统一契约（每个 drill 都 setInterval 它刷新基准）。 */
  snapshotRefreshMs: SNAPSHOT_REFRESH_MS,
  /** 快照到达抖动：设计 §3 实测"交易所往返 p99 是 100–300ms 量级"。 */
  rttJitterMs: [300, 0, 300, 0, 300, 0] as readonly number[],
  /** 健康路径观测窗口（60s = 12 个刷新周期，够覆盖抖动循环）。 */
  healthyDurationMs: 60_000,
  /** 断供窗口：真实配置的心跳超时（bin/core.mjs 与全部 drill 都是 30s）。 */
  outageWindowMs: 30_000,
  /** 心跳超时/重连退避：drill 真实配置 reconnectBaseMs=1000 / reconnectMaxMs=8000。 */
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 8_000,
  /** 洪泛速率阶梯（条/秒/标的，**总速率**：基准 1/s + 额外洪泛）。 */
  floodLadderPerSec: [5, 20, 50, 100, 200] as readonly number[],
  /**
   * 设计输入速率：合约推送面（如 Binance aggTrade）在剧烈行情下的量级。
   * **本仓没有实测过这个数**（见记录的"未验证"一节），它是标定的输入假设；
   * 换行情源必须重标。
   */
  designFloodPerSec: 100,
  /** 失控重试环：1 秒内 50 次重对齐请求（上侧失效的探针）。 */
  abuseBurstPerSec: 50,
} as const

/** 档位（取值的"档"是人定的整数关口；规则是"不小于实测值 × 余量的最小档"）。 */
export const AGE_LADDER_MS = [5_000, 7_500, 10_000, 15_000, 30_000, 60_000] as readonly number[]
export const BUFFER_LADDER_TICKS = [5_000, 10_000, 12_000, 15_000, 20_000, 30_000, 60_000] as readonly number[]
export const REALIGN_LADDER = [1, 2, 4, 8, 16, 32, 64] as readonly number[]

/** 除三个上界外的固定参数（不在本次标定范围，取值出处写在 alignment-params.ts）。 */
const BASE = {
  realignRefillPerSec: 1,
  divergenceBps: 50,
  divergenceStrikes: 2,
  orderTokenCapacity: 8,
  orderRefillPerSec: 1,
} as const

/** 标定期间的"无界"参数：测峰值时不许界来截断观测（截断了测到的就是界，不是需求）。 */
const UNBOUNDED: AlignmentParams = { ...BASE, snapshotAgeBudgetMs: 1_000_000, bufferMaxTicks: 10_000_000, bufferMaxBytes: 1_280_000_000, realignTokenCapacity: 1_000_000 }

/** 128 B/条：与 alignment.ts 的按条估算同一个口径（字节界的来源是条数界的换算）。 */
export const BYTES_PER_TICK = 128

/** 每次重连退避梯子上的重连时刻（1s/2s/4s/8s…封顶 8s，60s 窗口内 9 次）。 */
export function reconnectLadderMs(baseMs: number, maxMs: number, windowMs: number): readonly number[] {
  const times: number[] = []
  let atMs = 0
  let attempt = 0
  for (;;) {
    atMs += Math.min(maxMs, baseMs * Math.pow(2, attempt))
    attempt += 1
    if (atMs > windowMs) break
    times.push(atMs)
  }
  return times
}

/** 快照刷新失败的独立重对齐请求：其中 t=15000 与一次重连**同一秒**（相关双故障）。 */
export const REFRESH_FAILURE_REALIGN_AT_MS = [15_000, 25_000, 35_000, 45_000] as readonly number[]

export interface AgeRow {
  readonly rungMs: number
  /** 健康路径上被判 snapshot-stale 的 tick 数（下侧失效：正常行情被误丢）。 */
  readonly falseDrops: number
  /** 快照已死的标的多发布的 tick 数（上侧失效：该丢的没丢）。 */
  readonly overduePublished: number
  readonly headroom: number
}

export interface BufferRow {
  readonly maxTicks: number
  readonly maxBytes: number
  /** 越界清空次数（> 0 即发生真实 tick 丢失）。 */
  readonly forcedResnapshots: number
  /** 相对无界回放少发布的 tick 数（界造成的真实丢失）。 */
  readonly lostTicks: number
  readonly headroom: number
}

export interface RealignRow {
  readonly capacity: number
  /** 合法风暴里被拒的重对齐请求（下侧失效：永远回不到 aligned）。 */
  readonly legitRefused: number
  /** 失控重试环里被放行的请求（= 50 即完全没被抑制）。 */
  readonly abuseGranted: number
  readonly headroom: number
}

export interface AlignmentCalibration {
  readonly headSha: string | null
  readonly age: {
    readonly samples: number
    readonly p50: number
    readonly p99: number
    readonly max: number
    readonly requiredMs: number
    readonly rows: readonly AgeRow[]
    readonly chosenMs: number
    /** 实测的误丢起点（第一个出现误丢的档）。 */
    readonly falseDropStartsAtMs: number
  }
  readonly buffer: {
    readonly rateRows: readonly { readonly floodPerSec: number; readonly perSymbolPeakTicks: number; readonly globalPeakTicks: number; readonly globalPeakBytes: number }[]
    readonly requiredTicks: number
    readonly requiredBytes: number
    readonly rows: readonly BufferRow[]
    readonly chosenTicks: number
    readonly chosenBytes: number
    readonly lossStartsAtTicks: number
    readonly unboundedPublishedTicks: number
  }
  readonly realign: {
    readonly stormRequests: number
    readonly stormDemandPerWindow: number
    readonly abuseRequests: number
    readonly rows: readonly RealignRow[]
    readonly chosenCapacity: number
    readonly refusalStartsAtCapacity: number
  }
  readonly suggested: AlignmentParams
  readonly failures: readonly string[]
}

/** 健康路径：周期刷新 + 到达抖动（年龄分布的实测来源）。 */
function healthyScenario(): MultiSymbolScenario {
  return {
    name: 'healthy-refresh-jitter',
    durationMs: INPUTS.healthyDurationMs,
    snapshotBurst: 0,
    feeds: CALIBRATION_SYMBOLS.map((symbol): MultiSymbolFeed => ({
      symbol,
      snapshotDelayMs: INPUTS.rttJitterMs[0]!,
      snapshotRefreshMs: INPUTS.snapshotRefreshMs,
      tickEveryMs: 100,
      snapshotDelaysMs: INPUTS.rttJitterMs,
    })),
  }
}

/** 快照已死：t=0 一张基准、此后不刷新（上侧失效的探针）。 */
function deadFeedScenario(): MultiSymbolScenario {
  return {
    name: 'dead-feed-one-shot',
    durationMs: INPUTS.healthyDurationMs,
    snapshotBurst: 0,
    feeds: CALIBRATION_SYMBOLS.map((symbol): MultiSymbolFeed => ({
      symbol,
      snapshotDelayMs: 0,
      snapshotRefreshMs: 0,
      tickEveryMs: 100,
    })),
  }
}

/** 断供窗口：t=0..outageWindowMs 没有基准（洪泛全进缓冲），窗口末快照到达并补发。 */
function outageScenario(floodPerSec: number): MultiSymbolScenario {
  return {
    name: 'bootstrap-outage-flood-' + String(floodPerSec),
    durationMs: INPUTS.outageWindowMs + 1_000,
    snapshotBurst: 0,
    feeds: CALIBRATION_SYMBOLS.map((symbol): MultiSymbolFeed => ({
      symbol,
      snapshotDelayMs: INPUTS.outageWindowMs,
      snapshotRefreshMs: 0,
      tickEveryMs: 1_000,
      // 基准节奏 1/s + 洪泛 = 该标的总速率 floodPerSec 条/秒
      tickFloodPerSec: Math.max(0, floodPerSec - 1),
    })),
  }
}

/** 重连风暴：退避梯子上的 9 次重连（每次都换世代 ⇒ 必须重新快照）+ 快照刷新失败。 */
function reconnectStormScenario(): HarnessScenario {
  const reconnectAtMs = reconnectLadderMs(INPUTS.reconnectBaseMs, INPUTS.reconnectMaxMs, INPUTS.healthyDurationMs)
  return {
    name: 'reconnect-storm',
    symbol: 'BTC/USDT',
    durationMs: INPUTS.healthyDurationMs,
    tickEveryMs: 100,
    snapshotDelayMs: INPUTS.rttJitterMs[0]!,
    outOfOrderEvery: 0,
    epochChanges: reconnectAtMs.length,
    epochChangeAtMs: reconnectAtMs,
    tickFloodPerSec: 0,
    snapshotBurst: 0,
    realignOnEpochChange: true,
    realignAtMs: REFRESH_FAILURE_REALIGN_AT_MS,
  }
}

/** 失控重试环：1 秒内打满 abuseBurstPerSec 次（上侧失效的探针）。 */
function abuseScenario(): HarnessScenario {
  return {
    name: 'abuse-retry-loop',
    symbol: 'BTC/USDT',
    durationMs: 2_000,
    tickEveryMs: 100,
    snapshotDelayMs: 0,
    outOfOrderEvery: 0,
    epochChanges: 0,
    tickFloodPerSec: 0,
    snapshotBurst: 0,
    realignAtMs: Array.from({ length: INPUTS.abuseBurstPerSec }, (_unused, index) => index * (1_000 / INPUTS.abuseBurstPerSec)),
  }
}

/** 最小档：不小于 x 的最小档位；没有满足的档就取最大档（并让断言把它标红）。 */
function pickRung(ladder: readonly number[], x: number): number {
  for (const rung of ladder) if (rung >= x) return rung
  return ladder[ladder.length - 1]!
}

function headSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/**
 * 跑完整标定（三组测量 + 上下档边界）。**确定性**：同样的代码必然出同样的数。
 */
export function calibrateAlignment(): AlignmentCalibration {
  const failures: string[] = []

  // ① 快照年龄 ---------------------------------------------------------------
  const healthy = runMultiSymbolScenario(UNBOUNDED, healthyScenario())
  const age = summarizeAgeSamples(healthy.snapshotAgeSamplesMs)
  const requiredMs = age.max
  const deadAtRequired = runMultiSymbolScenario({ ...UNBOUNDED, snapshotAgeBudgetMs: requiredMs }, deadFeedScenario())
  const ageRows: AgeRow[] = AGE_LADDER_MS.map((rungMs) => {
    const healthyRun = runMultiSymbolScenario({ ...UNBOUNDED, snapshotAgeBudgetMs: rungMs }, healthyScenario())
    const deadRun = runMultiSymbolScenario({ ...UNBOUNDED, snapshotAgeBudgetMs: rungMs }, deadFeedScenario())
    const falseDrops = Object.values(healthyRun.bySymbol).reduce((sum, entry) => sum + entry.staleDrops, 0)
    return {
      rungMs,
      falseDrops,
      overduePublished: Math.max(0, deadRun.publishedTicks - deadAtRequired.publishedTicks),
      headroom: rungMs / requiredMs,
    }
  })
  const chosenMs = pickRung(AGE_LADDER_MS, requiredMs * HEADROOM)
  const falseDropStartsAtMs = ageRows.find((row) => row.falseDrops > 0)?.rungMs ?? 0
  if (requiredMs <= INPUTS.snapshotRefreshMs) failures.push('年龄预算的实测需求 ' + String(requiredMs) + 'ms 不大于刷新节奏 ' + String(INPUTS.snapshotRefreshMs) + 'ms：场景本身不成立')
  if (falseDropStartsAtMs === 0) failures.push('年龄阶梯里没有任何一档出现误丢：下侧边界没有被实测到')
  if ((ageRows.find((row) => row.rungMs === chosenMs)?.falseDrops ?? -1) !== 0) failures.push('选取档 ' + String(chosenMs) + 'ms 在健康路径上仍然误丢')

  // ② 缓冲全局界 -------------------------------------------------------------
  const rateRows = INPUTS.floodLadderPerSec.map((floodPerSec) => {
    const metrics = runMultiSymbolScenario(UNBOUNDED, outageScenario(floodPerSec))
    const perSymbolPeakTicks = Math.max(...Object.values(metrics.bySymbol).map((entry) => entry.maxBufferTicks))
    return { floodPerSec, perSymbolPeakTicks, globalPeakTicks: metrics.maxGlobalBufferTicks, globalPeakBytes: metrics.maxGlobalBufferBytes }
  })
  const design = rateRows.find((row) => row.floodPerSec === INPUTS.designFloodPerSec)
  if (design === undefined) throw new Error('设计速率不在洪泛阶梯里：' + String(INPUTS.designFloodPerSec))
  const requiredTicks = design.globalPeakTicks
  const requiredBytes = design.globalPeakBytes
  const unboundedOutage = runMultiSymbolScenario(UNBOUNDED, outageScenario(INPUTS.designFloodPerSec))
  const bufferRows: BufferRow[] = BUFFER_LADDER_TICKS.map((maxTicks) => {
    const maxBytes = maxTicks * BYTES_PER_TICK
    const metrics = runMultiSymbolScenario({ ...UNBOUNDED, bufferMaxTicks: maxTicks, bufferMaxBytes: maxBytes }, outageScenario(INPUTS.designFloodPerSec))
    return {
      maxTicks,
      maxBytes,
      forcedResnapshots: metrics.forcedResnapshots,
      lostTicks: Math.max(0, unboundedOutage.publishedTicks - metrics.publishedTicks),
      headroom: maxTicks / requiredTicks,
    }
  })
  const chosenTicks = pickRung(BUFFER_LADDER_TICKS, requiredTicks * HEADROOM)
  const lossStartsAtTicks = bufferRows.find((row) => row.lostTicks > 0)?.maxTicks ?? 0
  if (requiredTicks <= 0) failures.push('洪泛实测没有观察到缓冲峰值：场景本身不成立')
  if (lossStartsAtTicks === 0) failures.push('缓冲阶梯里没有任何一档出现越界丢失：下侧边界没有被实测到')
  if ((bufferRows.find((row) => row.maxTicks === chosenTicks)?.lostTicks ?? -1) !== 0) failures.push('选取档 ' + String(chosenTicks) + ' 条在断供窗口里仍然丢 tick')

  // ③ 重对齐令牌桶 -----------------------------------------------------------
  const stormScenario = reconnectStormScenario()
  const storm = runScenario(UNBOUNDED, stormScenario)
  const stormDemandPerWindow = peakDemandInWindow(storm.realignRequestedAtMs, 1_000 / BASE.realignRefillPerSec)
  const abuse = abuseScenario()
  const abuseRun = runScenario(UNBOUNDED, abuse)
  const realignRows: RealignRow[] = REALIGN_LADDER.map((capacity) => {
    const legit = runScenario({ ...UNBOUNDED, realignTokenCapacity: capacity }, stormScenario)
    const attacker = runScenario({ ...UNBOUNDED, realignTokenCapacity: capacity }, abuse)
    return {
      capacity,
      legitRefused: legit.realignRefused,
      abuseGranted: attacker.realignGranted,
      headroom: capacity / stormDemandPerWindow,
    }
  })
  const chosenCapacity = pickRung(REALIGN_LADDER, stormDemandPerWindow * HEADROOM)
  const refusalStartsAtCapacity = realignRows.find((row) => row.legitRefused > 0)?.capacity ?? 0
  if (refusalStartsAtCapacity === 0) failures.push('重对齐阶梯里没有任何一档误拒合法请求：下侧边界没有被实测到')
  const chosenRealign = realignRows.find((row) => row.capacity === chosenCapacity)
  if (chosenRealign === undefined || chosenRealign.legitRefused !== 0) failures.push('选取档容量 ' + String(chosenCapacity) + ' 误拒了合法重对齐')
  if ((chosenRealign?.abuseGranted ?? INPUTS.abuseBurstPerSec) >= INPUTS.abuseBurstPerSec) failures.push('选取档容量 ' + String(chosenCapacity) + ' 没有抑制失控重试环')

  const suggested: AlignmentParams = {
    ...BASE,
    snapshotAgeBudgetMs: chosenMs,
    bufferMaxTicks: chosenTicks,
    bufferMaxBytes: chosenTicks * BYTES_PER_TICK,
    realignTokenCapacity: chosenCapacity,
  }
  return {
    headSha: headSha(),
    age: { samples: age.count, p50: age.p50, p99: age.p99, max: age.max, requiredMs, rows: ageRows, chosenMs, falseDropStartsAtMs },
    buffer: { rateRows, requiredTicks, requiredBytes, rows: bufferRows, chosenTicks, chosenBytes: chosenTicks * BYTES_PER_TICK, lossStartsAtTicks, unboundedPublishedTicks: unboundedOutage.publishedTicks },
    realign: { stormRequests: storm.realignRequestedAtMs.length, stormDemandPerWindow, abuseRequests: abuseRun.realignRequestedAtMs.length, rows: realignRows, chosenCapacity, refusalStartsAtCapacity },
    suggested,
    failures,
  }
}

/** 渲染标定报告（原样贴进 docs/design/alignment-calibration.md）。 */
export function renderCalibrationReport(run: AlignmentCalibration): string {
  const lines: string[] = []
  const say = (text: string): void => { lines.push(text) }
  say('=== 行情对齐上界标定（设计 §3 门禁 / §13 不变量 #23）===')
  say('HEAD: ' + (run.headSha ?? '(git 不可用)') + ' · 命令: node packages/tradectl/drill/calibrate-alignment.ts')
  say('')
  say('输入（每条都有出处；换行情源/换交易所先改这里再重跑）：')
  say('  快照刷新节奏      = ' + String(INPUTS.snapshotRefreshMs) + 'ms（drill 统一契约 SNAPSHOT_REFRESH_MS）')
  say('  快照到达抖动      = ' + JSON.stringify(INPUTS.rttJitterMs) + 'ms（设计 §3 实测交易所往返 p99 100–300ms）')
  say('  断供窗口          = ' + String(INPUTS.outageWindowMs) + 'ms（心跳超时，bin/core.mjs 与全部 drill 的真实配置）')
  say('  重连退避          = ' + String(INPUTS.reconnectBaseMs) + 'ms × 2^n 封顶 ' + String(INPUTS.reconnectMaxMs) + 'ms（drill 真实配置）')
  say('  标的数            = ' + String(CALIBRATION_SYMBOLS.length) + '（' + CALIBRATION_SYMBOLS.join(', ') + '）')
  say('  洪泛阶梯          = ' + INPUTS.floodLadderPerSec.join('/') + ' 条/秒/标的；设计输入 = ' + String(INPUTS.designFloodPerSec) + '（**本仓未实测，见记录"未验证"**）')
  say('  失控重试环        = ' + String(INPUTS.abuseBurstPerSec) + ' 次/秒')
  say('')
  say('① 快照年龄（健康路径 ' + String(INPUTS.healthyDurationMs) + 'ms 回放，样本 ' + String(run.age.samples) + ' 条）')
  say('   p50=' + String(run.age.p50) + 'ms  p99=' + String(run.age.p99) + 'ms  max=' + String(run.age.max) + 'ms ⇒ 需求 = max = ' + String(run.age.requiredMs) + 'ms')
  say('   档位(ms)   头寸   健康路径误丢   快照已死的多发布')
  for (const row of run.age.rows) {
    say('   ' + String(row.rungMs).padStart(7) + '  ' + row.headroom.toFixed(2).padStart(5) + 'x  ' + String(row.falseDrops).padStart(11) + '  ' + String(row.overduePublished).padStart(14))
  }
  say('   误丢起点 = ' + String(run.age.falseDropStartsAtMs) + 'ms 档；取值 = ' + String(run.age.chosenMs) + 'ms（不小于需求 × ' + String(HEADROOM) + ' 的最小档）')
  say('')
  say('② 缓冲界（断供窗口 ' + String(INPUTS.outageWindowMs) + 'ms，窗口末快照到达后补发）')
  say('   速率(条/秒/标的)   每标的峰值(条)   全局峰值(条)   全局峰值(字节)')
  for (const row of run.buffer.rateRows) {
    say('   ' + String(row.floodPerSec).padStart(15) + '  ' + String(row.perSymbolPeakTicks).padStart(13) + '  ' + String(row.globalPeakTicks).padStart(12) + '  ' + String(row.globalPeakBytes).padStart(14))
  }
  say('   设计输入 ' + String(INPUTS.designFloodPerSec) + ' 条/秒/标的 ⇒ 需求 = ' + String(run.buffer.requiredTicks) + ' 条 / ' + String(run.buffer.requiredBytes) + ' 字节')
  say('   档位(条)     头寸   越界清空   界造成的丢失(条)')
  for (const row of run.buffer.rows) {
    say('   ' + String(row.maxTicks).padStart(8) + '  ' + row.headroom.toFixed(2).padStart(5) + 'x  ' + String(row.forcedResnapshots).padStart(8) + '  ' + String(row.lostTicks).padStart(16))
  }
  say('   丢失起点 = ' + String(run.buffer.lossStartsAtTicks) + ' 条档；取值 = ' + String(run.buffer.chosenTicks) + ' 条 / ' + String(run.buffer.chosenBytes) + ' 字节（不小于需求 × ' + String(HEADROOM) + ' 的最小档）')
  say('   无界回放共补发 ' + String(run.buffer.unboundedPublishedTicks) + ' 条（界造成的丢失以它为基准）')
  say('')
  say('③ 重对齐令牌桶（重连风暴：退避梯子 ' + String(run.realign.stormRequests) + ' 次请求，含 t=15s 的相关双故障）')
  say('   风暴需求 = ' + String(run.realign.stormDemandPerWindow) + ' 次/回填窗口；失控重试环 = ' + String(run.realign.abuseRequests) + ' 次/秒')
  say('   档位   头寸   合法请求被拒   失控请求被放行')
  for (const row of run.realign.rows) {
    say('   ' + String(row.capacity).padStart(4) + '  ' + row.headroom.toFixed(2).padStart(5) + 'x  ' + String(row.legitRefused).padStart(12) + '  ' + String(row.abuseGranted).padStart(14))
  }
  say('   误拒起点 = 容量 ' + String(run.realign.refusalStartsAtCapacity) + '；取值 = ' + String(run.realign.chosenCapacity) + '（不小于需求 × ' + String(HEADROOM) + ' 的最小档）')
  say('')
  say('取值（写入 drill/alignment-params.ts）：')
  say('   ' + JSON.stringify(run.suggested))
  say('')
  say(run.failures.length === 0
    ? '[calibrate-alignment] ✓ 三组实测齐备，上下档边界都被测到，取值来自"实测 × ' + String(HEADROOM) + ' 的最小档"'
    : '[calibrate-alignment] ✗ ' + run.failures.join(' | '))
  return lines.join(NL) + NL
}

/** 直接跑（node packages/tradectl/drill/calibrate-alignment.ts）；被 import 时不执行。 */
function isMainModule(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isMainModule()) {
  const run = calibrateAlignment()
  process.stdout.write(renderCalibrationReport(run))
  if (run.failures.length > 0) process.exit(1)
}
