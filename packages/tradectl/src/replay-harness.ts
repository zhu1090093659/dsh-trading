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
 * ## 多标的场景（2026-10-02 加，验收发现 F3）
 *
 * `runScenario` 只驱动**一只**标的；对齐态与快照年龄是标的级的，所以"一只标的快照
 * 断供、另一只健康"这一整类失效在单标的场景里**结构上跑不出来**。`runMultiSymbolScenario`
 * 补上这一维：每个标的各有 `snapshotDelayMs`（null = **断供**）与 `snapshotRefreshMs`，
 * 逐标的出实测，并给出聚合态（`worstAlignment`，**只用于观测/告警**）。
 *
 * @module @dshtrading/tractl/replay-harness
 */
import { createAlignment, type AlignmentEvent, type AlignmentParams } from './alignment.ts'
import type { Alignment } from './risk-gate.ts'

/** 一个回放场景（全部是确定性参数，没有随机——随机场景不可复现就无法标定）。 */
export interface HarnessScenario {
  readonly name: string
  /** 场景驱动的标的（缺省 `BTC/USDT`）：对齐态与快照年龄都是**标的级**的。 */
  readonly symbol?: string
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

/** 多标的场景里一只标的的喂法。 */
export interface MultiSymbolFeed {
  readonly symbol: string
  /** 首张快照的到达延迟；**null = 快照断供**（这只标的从头到尾没有基准）。 */
  readonly snapshotDelayMs: number | null
  /** 基准快照的周期刷新间隔；0 = 只发首张（此后靠年龄预算自然转 stale）。 */
  readonly snapshotRefreshMs: number
  /** 该标的的 tick 间隔（ms）。 */
  readonly tickEveryMs: number
  /** 该标的的价格基数（缺省 60_000）。 */
  readonly basePrice?: number
}

/** 一个多标的回放场景（同样全确定性）。 */
export interface MultiSymbolScenario {
  readonly name: string
  readonly durationMs: number
  /** ⑤ 预算占用：t=0 一次性打出的重对齐请求数（占满令牌桶）。 */
  readonly snapshotBurst: number
  readonly feeds: readonly MultiSymbolFeed[]
}

/** 标定只读这几个实测值：单标的与多标的场景都产出它们。 */
export interface CalibrationMeasurement {
  readonly name: string
  readonly publishedTicks: number
  readonly droppedTicks: number
  readonly forcedResnapshots: number
  readonly maxBufferTicks: number
  readonly maxBufferBytes: number
  /**
   * 最长的"没有新快照"间隔（ms）。年龄预算必须不小于刷新节奏，所以它是
   * `snapshotAgeBudgetMs` 的实测来源。
   */
  readonly healthyGapMs: number
  readonly events: readonly AlignmentEvent[]
}

/** 回放实测结果。 */
export interface HarnessMetrics extends CalibrationMeasurement {
  readonly realignGranted: number
  readonly realignRefused: number
  readonly divergenceEvents: number
}

/** 单只标的在多标的场景里的实测。 */
export interface MultiSymbolMetricsBySymbol {
  readonly symbol: string
  readonly publishedTicks: number
  /** 因为本标的没有基准而只进缓冲的次数（不发布、也不丢）。 */
  readonly bufferedOnly: number
  /** 因为本标的自己的快照超龄而被丢弃的次数（异标的的新快照不算数）。 */
  readonly staleDrops: number
  readonly droppedTicks: number
  readonly finalAlignment: Alignment
  readonly finalSnapshotAgeMs: number | null
}

/** 多标的回放实测结果。 */
export interface MultiSymbolMetrics extends CalibrationMeasurement {
  readonly bySymbol: Readonly<Record<string, MultiSymbolMetricsBySymbol>>
  /** 聚合态（**只用于观测/告警**，不得作为发布/风控输入）。 */
  readonly worstAlignment: Alignment
  /** 到场景结束都没拿到过基准的标的（断供）。 */
  readonly symbolsNeverAligned: readonly string[]
}

/**
 * 跑一个场景（确定性：注入时钟从 0 开始按 tickEveryMs 推进）。
 * @param params - 待标定/待验证的参数。
 * @param scenario - 场景脚本。
 */
export function runScenario(params: AlignmentParams, scenario: HarnessScenario): HarnessMetrics {
  const symbol = scenario.symbol ?? 'BTC/USDT'
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
      state.onSnapshot({ epoch, symbol, price: 60_000, atMs: nowMs + scenario.snapshotDelayMs }, nowMs)
      snapshotsSent += 1
      healthyGapMs = Math.max(healthyGapMs, nowMs - 0)
    }
    if (snapshotsSent === 0) {
      // ① 快照延迟：第一张快照晚到
      state.onSnapshot({ epoch, symbol, price: 60_000, atMs: nowMs }, nowMs + scenario.snapshotDelayMs)
      snapshotsSent += 1
    }
    for (let i = 0; i < ticksPerStep; i += 1) {
      seq += 1
      const outOfOrder = scenario.outOfOrderEvery > 1 && seq % scenario.outOfOrderEvery === 0
      const outcome = state.onTick(
        { epoch, symbol, price: 60_000 + (seq % 7), atMs: nowMs, seq: outOfOrder ? Math.max(1, seq - 3) : seq },
        nowMs,
      )
      published += outcome.published.length
      const snapshot = state.state(nowMs, symbol)
      maxBufferTicks = Math.max(maxBufferTicks, snapshot.buffered)
      maxBufferBytes = Math.max(maxBufferBytes, snapshot.bytes)
    }
    // 分歧探测：每 10 步对一次账（前 3 次故意偏离，用于验证探测器）——分歧是标的级的
    if (nowMs % (scenario.tickEveryMs * 10) === 0 && nowMs > 0) {
      state.onHeartbeat(60_000, nowMs < scenario.tickEveryMs * 60 ? 60_000 * (1 + 0.01) : 60_000, nowMs, symbol)
    }
  }
  const final = state.state(scenario.durationMs, symbol)
  return {
    name: scenario.name,
    publishedTicks: published,
    droppedTicks: final.droppedTicks,
    forcedResnapshots: final.forcedResnapshots,
    maxBufferTicks,
    maxBufferBytes,
    healthyGapMs,
    realignGranted,
    realignRefused,
    divergenceEvents: state.events().filter((event) => event.kind === 'divergence').length,
    events: state.events(),
  }
}

/**
 * 跑一个**多标的**场景（确定性）。每个标的各有自己的快照喂法与 tick 节奏，
 * 对齐状态机必须逐标的独立判定——这正是 2026-10-02 F3 探针实测出的缺口。
 * @param params - 待标定/待验证的参数。
 * @param scenario - 多标的场景脚本。
 */
export function runMultiSymbolScenario(params: AlignmentParams, scenario: MultiSymbolScenario): MultiSymbolMetrics {
  const state = createAlignment(params, 0)
  const counters = new Map<string, { published: number; bufferedOnly: number; staleDrops: number }>()
  const sequences = new Map<string, number>()
  /** 下一次该发快照的时刻；Infinity = 不发（断供）。 */
  const nextSnapshotAtMs = new Map<string, number>()
  let realignGranted = 0
  let realignRefused = 0
  let healthyGapMs = 0
  let maxBufferTicks = 0
  let maxBufferBytes = 0

  for (const feed of scenario.feeds) {
    counters.set(feed.symbol, { published: 0, bufferedOnly: 0, staleDrops: 0 })
    sequences.set(feed.symbol, 0)
    nextSnapshotAtMs.set(feed.symbol, feed.snapshotDelayMs === null ? Number.POSITIVE_INFINITY : feed.snapshotDelayMs)
  }
  const lastSnapshotAtMs = new Map<string, number>()

  for (let i = 0; i < scenario.snapshotBurst; i += 1) {
    if (state.requestRealign(i).granted) realignGranted += 1
    else realignRefused += 1
  }

  const stepMs = Math.max(1, Math.min(...scenario.feeds.map((feed) => feed.tickEveryMs)))
  for (let nowMs = 0; nowMs <= scenario.durationMs; nowMs += stepMs) {
    for (const feed of scenario.feeds) {
      const counter = counters.get(feed.symbol)!
      const basePrice = feed.basePrice ?? 60_000
      // 基准快照：按延迟到首张，此后按刷新节奏（0 = 不再刷新）
      const due = nextSnapshotAtMs.get(feed.symbol) ?? Number.POSITIVE_INFINITY
      if (nowMs >= due) {
        const previous = lastSnapshotAtMs.get(feed.symbol)
        // 相邻快照间隔（含首张之前的等待）：年龄预算的实测来源
        healthyGapMs = Math.max(healthyGapMs, previous === undefined ? nowMs : nowMs - previous)
        lastSnapshotAtMs.set(feed.symbol, nowMs)
        nextSnapshotAtMs.set(feed.symbol, feed.snapshotRefreshMs > 0 ? nowMs + feed.snapshotRefreshMs : Number.POSITIVE_INFINITY)
        state.onSnapshot({ epoch: 1, symbol: feed.symbol, price: basePrice, atMs: nowMs }, nowMs)
      }
      if (nowMs % feed.tickEveryMs !== 0) continue
      const seq = (sequences.get(feed.symbol) ?? 0) + 1
      sequences.set(feed.symbol, seq)
      const outcome = state.onTick({ epoch: 1, symbol: feed.symbol, price: basePrice + (seq % 5), atMs: nowMs, seq }, nowMs)
      counter.published += outcome.published.length
      if (outcome.reason === 'buffered-only') counter.bufferedOnly += 1
      if (outcome.reason === 'snapshot-stale') counter.staleDrops += 1
      const view = state.state(nowMs, feed.symbol)
      maxBufferTicks = Math.max(maxBufferTicks, view.buffered)
      maxBufferBytes = Math.max(maxBufferBytes, view.bytes)
    }
  }

  const bySymbol: Record<string, MultiSymbolMetricsBySymbol> = {}
  const symbolsNeverAligned: string[] = []
  for (const feed of scenario.feeds) {
    const counter = counters.get(feed.symbol)!
    const view = state.state(scenario.durationMs, feed.symbol)
    if (view.snapshotAtMs === null) symbolsNeverAligned.push(feed.symbol)
    bySymbol[feed.symbol] = {
      symbol: feed.symbol,
      publishedTicks: counter.published,
      bufferedOnly: counter.bufferedOnly,
      staleDrops: counter.staleDrops,
      droppedTicks: view.droppedTicks,
      finalAlignment: view.alignment,
      finalSnapshotAgeMs: view.snapshotAgeMs,
    }
  }
  const aggregate = state.worstAlignment(scenario.durationMs)
  // 断供标的的"没有新快照的间隔"就是整段场景：这一条**不是**"把预算调大"能解决的，
  // 实测如实报出来，由标定人决定（不能靠加大年龄预算把断供洗成健康）。
  if (symbolsNeverAligned.length > 0) healthyGapMs = Math.max(healthyGapMs, scenario.durationMs)
  return {
    name: scenario.name,
    bySymbol,
    worstAlignment: aggregate.worstAlignment,
    symbolsNeverAligned,
    publishedTicks: Object.values(bySymbol).reduce((sum, entry) => sum + entry.publishedTicks, 0),
    droppedTicks: aggregate.droppedTicks,
    forcedResnapshots: aggregate.forcedResnapshots,
    maxBufferTicks,
    maxBufferBytes,
    healthyGapMs,
    events: state.events(),
  }
}

/** 标定结果：建议常量 + 它来自哪次实测（证据）。 */
export interface CalibrationResult {
  readonly suggested: AlignmentParams
  readonly measured: readonly (HarnessMetrics | MultiSymbolMetrics)[]
  readonly headroom: number
  readonly evidence: readonly string[]
}

/** 多标的场景用 `feeds` 判别（单标的场景没有这个字段）。 */
function isMultiSymbolScenario(scenario: HarnessScenario | MultiSymbolScenario): scenario is MultiSymbolScenario {
  return Array.isArray((scenario as MultiSymbolScenario).feeds)
}

/**
 * 用一组场景标定三个上界参数：取实测最大值 × 余量，并把每个数追到它来自哪次实测。
 * 单标的与多标的场景可以混着传（`feeds` 字段判别）。
 * @param base - 已确定的其他参数（阈值、下单预算等）。
 * @param scenarios - 场景集。
 * @param headroom - 余量倍数（默认 1.5）。
 */
export function calibrate(base: Omit<AlignmentParams, 'snapshotAgeBudgetMs' | 'bufferMaxTicks' | 'bufferMaxBytes' | 'realignTokenCapacity'>, scenarios: readonly (HarnessScenario | MultiSymbolScenario)[], headroom = 1.5): CalibrationResult {
  const provisional: AlignmentParams = {
    ...base,
    snapshotAgeBudgetMs: 1_000_000,
    bufferMaxTicks: 1_000_000,
    bufferMaxBytes: 1_000_000_000,
    realignTokenCapacity: Math.max(1, ...scenarios.map((scenario) => scenario.snapshotBurst + 1)),
  }
  const measured = scenarios.map((scenario) => isMultiSymbolScenario(scenario) ? runMultiSymbolScenario(provisional, scenario) : runScenario(provisional, scenario))
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
