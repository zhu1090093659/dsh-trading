/**
 * 录音-回放 harness（P3 步骤 4）：可注入五种条件，用来**标定**三个上界参数。
 *
 * 卡片把 harness 定为验收前提：年龄预算 / 缓冲条数与字节上限 / 重对齐令牌桶容量这三个
 * 数**不许写死猜测值**——必须先在 harness 上跑出实测，再按实测加余量写进参数。所以
 * 本模块只做两件事：跑场景、出实测；calibrate 把实测换算成建议常量并**带上证据**
 * （实测值 + 余量倍数），任何人看到常量都能追到它是怎么来的。
 *
 * 五种可注入条件（卡片原文）：
 *   ① 快照延迟 snapshotDelayMs  ② 乱序 outOfOrderEvery
 *   ③ epoch 变更 epochChanges   ④ tick 洪泛 tickFloodPerSec
 *   ⑤ 共享预算占用 snapshotBurst（占满重对齐桶）
 *
 * @module @dshtrading/tractl/replay-harness
 */
import { createAlignment, type AlignmentEvent, type AlignmentParams } from './alignment.ts'

/** 一个回放场景（全部是确定性参数，没有随机——随机场景不可复现就无法标定）。 */
export interface HarnessScenario {
  readonly name: string
  readonly durationMs: number
  readonly tickEveryMs: number
  /** ① 快照延迟：快照在多少毫秒之后才到。 */
  readonly snapshotDelayMs: number
  /** ② 每第 N 条 tick 故意乱序（0/1 = 不乱序）。 */
  readonly outOfOrderEvery: number
  /** ③ 中途切换 epoch 的次数。 */
  readonly epochChanges: number
  /** ④ tick 洪泛：额外注入的每秒 tick 数。 */
  readonly tickFloodPerSec: number
  /** ⑤ 预算占用：一次性打出的重对齐请求数（占满令牌桶）。 */
  readonly snapshotBurst: number
}

/** 回放实测结果。 */
export interface HarnessMetrics {
  readonly name: string
  readonly publishedTicks: number
  readonly droppedTicks: number
  readonly forcedResnapshots: number
  readonly maxBufferTicks: number
  readonly maxBufferBytes: number
  readonly realignGranted: number
  readonly realignRefused: number
  readonly divergenceEvents: number
  readonly healthyGapMs: number
  readonly events: readonly AlignmentEvent[]
}

/**
 * 跑一个场景（确定性：注入时钟从 0 开始按 tickEveryMs 推进）。
 * @param params - 待标定/待验证的参数。
 * @param scenario - 场景脚本。
 */
export function runScenario(params: AlignmentParams, scenario: HarnessScenario): HarnessMetrics {
  const state = createAlignment(params, 0)
  let published = 0
  let seq = 0
  let epoch = 1
  let realignGranted = 0
  let realignRefused = 0
  let snapshotsSent = 0
  let healthyGapMs = 0
  let maxBufferTicks = 0
  let maxBufferBytes = 0

  // ⑤ 预算占用：把重对齐桶打空
  for (let i = 0; i < scenario.snapshotBurst; i += 1) {
    if (state.requestRealign(i).granted) realignGranted += 1
    else realignRefused += 1
  }

  const ticksPerStep = Math.max(1, Math.round((scenario.tickFloodPerSec * scenario.tickEveryMs) / 1000))
  const epochChangeAt = scenario.epochChanges > 0 ? Math.floor(scenario.durationMs / (scenario.epochChanges + 1)) : Number.POSITIVE_INFINITY

  for (let nowMs = 0; nowMs <= scenario.durationMs; nowMs += scenario.tickEveryMs) {
    // ③ epoch 变更：换世代后必须重新快照
    if (nowMs >= epochChangeAt && epoch === 1 && scenario.epochChanges > 0) {
      epoch = 2
      state.onSnapshot({ epoch, symbol: 'BTC/USDT', price: 60_000, atMs: nowMs + scenario.snapshotDelayMs }, nowMs)
      snapshotsSent += 1
      healthyGapMs = Math.max(healthyGapMs, nowMs - 0)
    }
    if (snapshotsSent === 0) {
      // ① 快照延迟：第一张快照晚到
      state.onSnapshot({ epoch, symbol: 'BTC/USDT', price: 60_000, atMs: nowMs }, nowMs + scenario.snapshotDelayMs)
      snapshotsSent += 1
    }
    for (let i = 0; i < ticksPerStep; i += 1) {
      seq += 1
      const outOfOrder = scenario.outOfOrderEvery > 1 && seq % scenario.outOfOrderEvery === 0
      const outcome = state.onTick(
        { epoch, symbol: 'BTC/USDT', price: 60_000 + (seq % 7), atMs: nowMs, seq: outOfOrder ? Math.max(1, seq - 3) : seq },
        nowMs,
      )
      published += outcome.published.length
      const snapshot = state.state(nowMs)
      maxBufferTicks = Math.max(maxBufferTicks, snapshot.buffered)
      maxBufferBytes = Math.max(maxBufferBytes, snapshot.bytes)
    }
    // 分歧探测：每 10 步对一次账（前 3 次故意偏离，用于验证探测器）
    if (nowMs % (scenario.tickEveryMs * 10) === 0 && nowMs > 0) {
      state.onHeartbeat(60_000, nowMs < scenario.tickEveryMs * 60 ? 60_000 * (1 + 0.01) : 60_000, nowMs)
    }
  }
  const final = state.state(scenario.durationMs)
  return {
    name: scenario.name,
    publishedTicks: published,
    droppedTicks: final.droppedTicks,
    forcedResnapshots: final.forcedResnapshots,
    maxBufferTicks,
    maxBufferBytes,
    realignGranted,
    realignRefused,
    divergenceEvents: state.events().filter((event) => event.kind === 'divergence').length,
    healthyGapMs,
    events: state.events(),
  }
}

/** 标定结果：建议常量 + 它来自哪次实测（证据）。 */
export interface CalibrationResult {
  readonly suggested: AlignmentParams
  readonly measured: readonly HarnessMetrics[]
  readonly headroom: number
  readonly evidence: readonly string[]
}

/**
 * 用一组场景标定三个上界参数：取实测最大值 × 余量，并把每个数追到它来自哪次实测。
 * @param base - 已确定的其他参数（阈值、下单预算等）。
 * @param scenarios - 场景集。
 * @param headroom - 余量倍数（默认 1.5）。
 */
export function calibrate(base: Omit<AlignmentParams, 'snapshotAgeBudgetMs' | 'bufferMaxTicks' | 'bufferMaxBytes' | 'realignTokenCapacity'>, scenarios: readonly HarnessScenario[], headroom = 1.5): CalibrationResult {
  const provisional: AlignmentParams = {
    ...base,
    snapshotAgeBudgetMs: 1_000_000,
    bufferMaxTicks: 1_000_000,
    bufferMaxBytes: 1_000_000_000,
    realignTokenCapacity: Math.max(1, ...scenarios.map((scenario) => scenario.snapshotBurst + 1)),
  }
  const measured = scenarios.map((scenario) => runScenario(provisional, scenario))
  const maxBufferedTicks = Math.max(1, ...measured.map((metrics) => metrics.maxBufferTicks))
  const maxBufferedBytes = Math.max(BYTES_FLOOR, ...measured.map((metrics) => metrics.maxBufferBytes))
  const maxHealthyGap = Math.max(1, ...measured.map((metrics) => metrics.healthyGapMs))
  const maxRealignDemand = Math.max(1, ...scenarios.map((scenario) => scenario.snapshotBurst))
  const suggested: AlignmentParams = {
    ...base,
    snapshotAgeBudgetMs: Math.ceil(maxHealthyGap * headroom),
    bufferMaxTicks: Math.ceil(maxBufferedTicks * headroom),
    bufferMaxBytes: Math.ceil(maxBufferedBytes * headroom),
    realignTokenCapacity: Math.ceil(maxRealignDemand * headroom),
  }
  return {
    suggested,
    measured,
    headroom,
    evidence: [
      'snapshotAgeBudgetMs = ceil(maxHealthyGap ' + String(maxHealthyGap) + ' x ' + String(headroom) + ') = ' + String(suggested.snapshotAgeBudgetMs),
      'bufferMaxTicks = ceil(maxBufferedTicks ' + String(maxBufferedTicks) + ' x ' + String(headroom) + ') = ' + String(suggested.bufferMaxTicks),
      'bufferMaxBytes = ceil(maxBufferedBytes ' + String(maxBufferedBytes) + ' x ' + String(headroom) + ') = ' + String(suggested.bufferMaxBytes),
      'realignTokenCapacity = ceil(maxRealignDemand ' + String(maxRealignDemand) + ' x ' + String(headroom) + ') = ' + String(suggested.realignTokenCapacity),
    ],
  }
}

const BYTES_FLOOR = 128
