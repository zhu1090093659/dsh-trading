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
 * ## 多标的的场景（2026-10-02 加，验收发现 F3）
 *
 * `runScenario` 只驱动**一只**标的；对齐态与快照年龄是标的级的，所以"一只标的快照
 * 断供、另一只健康"这一整类失效在单标的场景里**结构上跑不出来**。`runMultiSymbolScenario`
 * 补上这一维：每个标的各有 `snapshotDelayMs`（null = **断供**）与 `snapshotRefreshMs`，
 * 逐标的出实测，并给出聚合态（`worstAlignment`，**只用于观测/告警**）。
 *
 * ## 标定口径的三次扩展（2026-10-02，不变量 #23）
 *
 * 上界参数要"按实测取数"，就要求 harness 能把**实测本身**出全；第一版只有最大值与计数，
 * 于是取了三个数却没有分布、没有全局峰值、没有重对齐需求曲线。补的三件：
 *
 *   1. `snapshotAgeSamplesMs`：**每条 tick 观察到的快照年龄**（不是只有最大值）。
 *      年龄预算的实测来源是 p50/p99/max 三个分位，只有一个 max 就没法说"p99 余量多少"。
 *   2. `maxGlobalBufferTicks` / `maxGlobalBufferBytes`：**全局**（所有标的合计）峰值。
 *      参数 `bufferMaxTicks`/`bufferMaxBytes` 是**全局界**（`alignment.ts` 拿 `buffer.length`
 *      比），而第一版只报被观测标的的单标的切片，用它去标全局界会系统性偏小。
 *   3. `realignRequestedAtMs` + `peakDemandInWindow`：重对齐令牌桶容量要覆盖的是
 *      **一个回填窗口内的峰值需求**（不是总次数）。`realignAtMs` 脚本与
 *      `realignOnEpochChange`（重连/epoch 变更的真实调用点）把需求时刻如实记下来。
 *
 * 同时修正一处**少算**：`publishedTicks` 此前只数 `onTick` 直接发布的那部分，
 * **快照到达后补发的缓冲 tick 一条都不计**——而"断供窗口里缓冲了多少、补发了多少"
 * 正是缓冲界的判据，少算会把界造成的丢失测成 0。现在两个发布入口都计入。
 *
 * 另外补两处注入能力：`epochChangeAtMs`（按真实退避梯子注入 N 次重连，旧实现只换一次
 * 世代）与 `MultiSymbolFeed.tickFloodPerSec`/`snapshotDelaysMs`（逐标的洪泛与到达抖动）。
 * 全部是**可选字段**，缺省行为与扩展前逐位一致。
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
  /**
   * ③' epoch 变更的**具体时刻**（ms，可乱序给，内部按序用）。
   * 缺省 = 把 `epochChanges` 次均匀铺在场景时长上（N=1 即老行为：中点换一次世代）。
   * 给真实退避梯子（1s/2s/4s/8s…）时用它，否则"重连风暴"退化成"均匀重连"。
   */
  readonly epochChangeAtMs?: readonly number[]
  /** ④ tick 洪泛：额外注入的每秒 tick 数。 */
  readonly tickFloodPerSec: number
  /** ⑤ 预算占用：一次性打出的重对齐请求数（占满令牌桶）。 */
  readonly snapshotBurst: number
  /** ③'' 每次 epoch 变更后是否发一次重对齐请求（换来世代必须重新快照，真实调用点）。 */
  readonly realignOnEpochChange?: boolean
  /** ⑤' 重对齐请求脚本：在这些时刻各发一次（与 epoch 变更正交，用于相关双故障）。 */
  readonly realignAtMs?: readonly number[]
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
  /** ④ 该标的的 tick 洪泛：每秒额外注入的 tick 数（缺省 0 = 只有基准节奏）。 */
  readonly tickFloodPerSec?: number
  /**
   * ① 每次刷新的**到达延迟**（ms，按序循环取用）：模拟交易所往返抖动。
   * 缺省 = 首张用 `snapshotDelayMs`、其后准点到达（扩展前的行为）。
   * 只有"到达延迟**抖动**"会推高健康路径的最大年龄（恒定延迟不推高），所以标定
   * 年龄预算必须给一组宽度不为零的延迟，否则实测出来的 max 是刷新节奏本身。
   */
  readonly snapshotDelaysMs?: readonly number[]
}

/** 一个多标的回放场景（同样全确定性）。 */
export interface MultiSymbolScenario {
  readonly name: string
  readonly durationMs: number
  /** ⑤ 预算占用：t=0 一次性打出的重对齐请求数（占满令牌桶）。 */
  readonly snapshotBurst: number
  /** ⑤' 重对齐请求脚本：在这些时刻各发一次。 */
  readonly realignAtMs?: readonly number[]
  readonly feeds: readonly MultiSymbolFeed[]
}

/** 标定只读这几个实测值：单标的与多标的场景都产出它们。 */
export interface CalibrationMeasurement {
  readonly name: string
  readonly publishedTicks: number
  readonly droppedTicks: number
  readonly forcedResnapshots: number
  /** 被观测标的的缓冲峰值（**单标的切片**；全局界看 maxGlobalBufferTicks）。 */
  readonly maxBufferTicks: number
  readonly maxBufferBytes: number
  /** **全局**（所有标的合计）缓冲峰值——`bufferMaxTicks`/`bufferMaxBytes` 的实测来源。 */
  readonly maxGlobalBufferTicks: number
  readonly maxGlobalBufferBytes: number
  /**
   * 最长的"没有新快照"间隔（ms）。年龄预算必须不小于刷新节奏，所以它是
   * `snapshotAgeBudgetMs` 的实测来源之一。
   */
  readonly healthyGapMs: number
  /**
   * **每条 tick 观察到的快照年龄**（ms，没有基准时不计入）。年龄预算的分位来源：
   * p50 说明常态、p99 说明抖动、max 说明边界。同一毫秒内的多条 tick 各记一次，
   * 因为"洪泛下有多少条 tick 处在超龄边缘"正是要测的东西。
   */
  readonly snapshotAgeSamplesMs: readonly number[]
  /** 发出重对齐请求的时刻（ms，不管批没批）——令牌桶容量的需求曲线。 */
  readonly realignRequestedAtMs: readonly number[]
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
  /** 本标的历史上的缓冲峰值（全局界按标的切片看的对照值）。 */
  maxBufferTicks: number
}

/** 多标的回放实测结果。 */
export interface MultiSymbolMetrics extends CalibrationMeasurement {
  readonly bySymbol: Readonly<Record<string, MultiSymbolMetricsBySymbol>>
  /** 聚合态（**只用于观测/告警**，不得作为发布/风控输入）。 */
  readonly worstAlignment: Alignment
  /** 到场景结束都没拿到过基准的标的（断供）。 */
  readonly symbolsNeverAligned: readonly string[]
}

/** 最近秩百分位（确定性；空样本返回 0）。 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((left, right) => left - right)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]!
}

/** 一批快照年龄样本的 count/p50/p99/max。 */
export function summarizeAgeSamples(samples: readonly number[]): { count: number; p50: number; p99: number; max: number } {
  let max = 0
  for (const sample of samples) if (sample > max) max = sample
  return { count: samples.length, p50: percentile(samples, 50), p99: percentile(samples, 99), max }
}

/**
 * 任意长度为 windowMs 的窗口内的最大请求数。
 *
 * 令牌桶容量的实测来源：桶容量要覆盖"一个回填窗口内的峰值需求"，而不是总次数——
 * 总次数是回填速率的事。窗口取 `1000 / realignRefillPerSec`。
 */
export function peakDemandInWindow(atMsList: readonly number[], windowMs: number): number {
  const sorted = [...atMsList].sort((left, right) => left - right)
  let peak = 0
  let start = 0
  for (let end = 0; end < sorted.length; end += 1) {
    while (sorted[end]! - sorted[start]! >= windowMs) start += 1
    peak = Math.max(peak, end - start + 1)
  }
  return peak
}

/** epoch 变更时刻：显式给了就用显式的（按序），否则均匀铺开（N=1 = 中点）。 */
function epochChangeTimesOf(scenario: HarnessScenario): readonly number[] {
  if (scenario.epochChangeAtMs !== undefined) return [...scenario.epochChangeAtMs].sort((left, right) => left - right)
  return Array.from({ length: scenario.epochChanges }, (_unused, index) =>
    Math.floor((scenario.durationMs * (index + 1)) / (scenario.epochChanges + 1)))
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
  let maxGlobalBufferTicks = 0
  let maxGlobalBufferBytes = 0
  const snapshotAgeSamplesMs: number[] = []
  const realignRequestedAtMs: number[] = []

  const requestRealign = (atMs: number): void => {
    realignRequestedAtMs.push(atMs)
    if (state.requestRealign(atMs).granted) realignGranted += 1
    else realignRefused += 1
  }

  // ⑤ 预算占用：把重对齐桶打空
  for (let i = 0; i < scenario.snapshotBurst; i += 1) requestRealign(i)
  // ⑤' 重对齐请求脚本（相关双故障：重连与快照刷新失败同时发生）
  for (const atMs of [...(scenario.realignAtMs ?? [])].sort((left, right) => left - right)) requestRealign(atMs)

  const epochChangeTimes = epochChangeTimesOf(scenario)
  let epochChangesDone = 0
  const ticksPerStep = Math.max(1, Math.round((scenario.tickFloodPerSec * scenario.tickEveryMs) / 1000))

  for (let nowMs = 0; nowMs <= scenario.durationMs; nowMs += scenario.tickEveryMs) {
    // ③ epoch 变更：换世代后必须重新快照（N 次 = 重连风暴；退避梯子见 epochChangeAtMs）
    while (epochChangesDone < epochChangeTimes.length && nowMs >= epochChangeTimes[epochChangesDone]!) {
      epoch += 1
      epochChangesDone += 1
      published += state.onSnapshot({ epoch, symbol, price: 60_000, atMs: nowMs + scenario.snapshotDelayMs }, nowMs).published.length
      snapshotsSent += 1
      healthyGapMs = Math.max(healthyGapMs, nowMs - 0)
      if (scenario.realignOnEpochChange === true) requestRealign(nowMs)
    }
    if (snapshotsSent === 0) {
      // ① 快照延迟：第一张快照晚到
      published += state.onSnapshot({ epoch, symbol, price: 60_000, atMs: nowMs }, nowMs + scenario.snapshotDelayMs).published.length
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
      maxGlobalBufferTicks = Math.max(maxGlobalBufferTicks, outcome.buffered)
    }
    // 采样放在 tick 循环之后：一个 step 内缓冲只增不减（刷新/清空都发生在 step 开头），
    // 所以"step 末"就是"step 内峰值"，不必逐条 tick 调 state()（洪泛下那是 O(n²)）。
    const view = state.state(nowMs, symbol)
    maxBufferTicks = Math.max(maxBufferTicks, view.buffered)
    maxBufferBytes = Math.max(maxBufferBytes, view.bytes)
    if (view.snapshotAgeMs !== null) for (let i = 0; i < ticksPerStep; i += 1) snapshotAgeSamplesMs.push(view.snapshotAgeMs)
    const aggregate = state.worstAlignment(nowMs)
    maxGlobalBufferTicks = Math.max(maxGlobalBufferTicks, aggregate.buffered)
    maxGlobalBufferBytes = Math.max(maxGlobalBufferBytes, aggregate.bytes)
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
    maxGlobalBufferTicks,
    maxGlobalBufferBytes,
    healthyGapMs,
    snapshotAgeSamplesMs,
    realignRequestedAtMs,
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
  const counters = new Map<string, { published: number; bufferedOnly: number; staleDrops: number; maxBufferTicks: number }>()
  const sequences = new Map<string, number>()
  /** 下一次该发快照的时刻（**计划时刻**，不是到达时刻）；Infinity = 不发（断供）。 */
  const nextSnapshotAtMs = new Map<string, number>()
  /** 已发出但还没到达的快照（到达延迟抖动）；null = 没有在途快照。 */
  const pendingArrivalAtMs = new Map<string, number | null>()
  /** 第几张快照（决定 snapshotDelaysMs 取哪一格）。 */
  const snapshotIndex = new Map<string, number>()
  let realignGranted = 0
  let realignRefused = 0
  let healthyGapMs = 0
  let maxBufferTicks = 0
  let maxBufferBytes = 0
  let maxGlobalBufferTicks = 0
  let maxGlobalBufferBytes = 0
  const snapshotAgeSamplesMs: number[] = []
  const realignRequestedAtMs: number[] = []

  const requestRealign = (atMs: number): void => {
    realignRequestedAtMs.push(atMs)
    if (state.requestRealign(atMs).granted) realignGranted += 1
    else realignRefused += 1
  }

  for (const feed of scenario.feeds) {
    counters.set(feed.symbol, { published: 0, bufferedOnly: 0, staleDrops: 0, maxBufferTicks: 0 })
    sequences.set(feed.symbol, 0)
    nextSnapshotAtMs.set(feed.symbol, feed.snapshotDelayMs === null ? Number.POSITIVE_INFINITY : 0)
    pendingArrivalAtMs.set(feed.symbol, null)
    snapshotIndex.set(feed.symbol, 0)
  }
  const lastSnapshotAtMs = new Map<string, number>()

  for (let i = 0; i < scenario.snapshotBurst; i += 1) requestRealign(i)
  for (const atMs of [...(scenario.realignAtMs ?? [])].sort((left, right) => left - right)) requestRealign(atMs)

  /** 本次快照的到达延迟：给了 snapshotDelaysMs 就按序循环，否则首张用 snapshotDelayMs。 */
  const arrivalDelayOf = (feed: MultiSymbolFeed, index: number): number => {
    const delays = feed.snapshotDelaysMs
    if (delays !== undefined && delays.length > 0) return delays[index % delays.length]!
    return index === 0 ? (feed.snapshotDelayMs ?? 0) : 0
  }

  const stepMs = Math.max(1, Math.min(...scenario.feeds.map((feed) => feed.tickEveryMs)))
  for (let nowMs = 0; nowMs <= scenario.durationMs; nowMs += stepMs) {
    for (const feed of scenario.feeds) {
      const counter = counters.get(feed.symbol)!
      const basePrice = feed.basePrice ?? 60_000
      // 快照计划：按刷新节奏排下一张；到达延迟只影响"什么时候到达"，不影响节奏
      const due = nextSnapshotAtMs.get(feed.symbol) ?? Number.POSITIVE_INFINITY
      if (nowMs >= due) {
        const index = snapshotIndex.get(feed.symbol) ?? 0
        const delay = arrivalDelayOf(feed, index)
        snapshotIndex.set(feed.symbol, index + 1)
        nextSnapshotAtMs.set(feed.symbol, feed.snapshotRefreshMs > 0 ? nowMs + feed.snapshotRefreshMs : Number.POSITIVE_INFINITY)
        if (delay <= 0) {
          const previous = lastSnapshotAtMs.get(feed.symbol)
          healthyGapMs = Math.max(healthyGapMs, previous === undefined ? nowMs : nowMs - previous)
          lastSnapshotAtMs.set(feed.symbol, nowMs)
          counter.published += state.onSnapshot({ epoch: 1, symbol: feed.symbol, price: basePrice, atMs: nowMs }, nowMs).published.length
        } else {
          pendingArrivalAtMs.set(feed.symbol, nowMs + delay)
        }
      }
      // 在途快照到达（到达时刻记账：快照年龄从**到达**算起）
      const pending = pendingArrivalAtMs.get(feed.symbol) ?? null
      if (pending !== null && nowMs >= pending) {
        const previous = lastSnapshotAtMs.get(feed.symbol)
        healthyGapMs = Math.max(healthyGapMs, previous === undefined ? nowMs : nowMs - previous)
        lastSnapshotAtMs.set(feed.symbol, nowMs)
        pendingArrivalAtMs.set(feed.symbol, null)
        counter.published += state.onSnapshot({ epoch: 1, symbol: feed.symbol, price: basePrice, atMs: nowMs }, nowMs).published.length
      }
      const onGrid = nowMs % feed.tickEveryMs === 0
      const extra = Math.max(0, Math.round(((feed.tickFloodPerSec ?? 0) * stepMs) / 1000))
      const tickCount = (onGrid ? 1 : 0) + extra
      for (let i = 0; i < tickCount; i += 1) {
        const seq = (sequences.get(feed.symbol) ?? 0) + 1
        sequences.set(feed.symbol, seq)
        const outcome = state.onTick({ epoch: 1, symbol: feed.symbol, price: basePrice + (seq % 5), atMs: nowMs, seq }, nowMs)
        counter.published += outcome.published.length
        if (outcome.reason === 'buffered-only') counter.bufferedOnly += 1
        if (outcome.reason === 'snapshot-stale') counter.staleDrops += 1
        maxGlobalBufferTicks = Math.max(maxGlobalBufferTicks, outcome.buffered)
      }
      if (tickCount > 0) {
        // step 末采样 = step 内峰值（见 runScenario 的同款说明）
        const view = state.state(nowMs, feed.symbol)
        counter.maxBufferTicks = Math.max(counter.maxBufferTicks, view.buffered)
        maxBufferTicks = Math.max(maxBufferTicks, view.buffered)
        maxBufferBytes = Math.max(maxBufferBytes, view.bytes)
        if (view.snapshotAgeMs !== null) for (let i = 0; i < tickCount; i += 1) snapshotAgeSamplesMs.push(view.snapshotAgeMs)
      }
    }
    const aggregate = state.worstAlignment(nowMs)
    maxGlobalBufferTicks = Math.max(maxGlobalBufferTicks, aggregate.buffered)
    maxGlobalBufferBytes = Math.max(maxGlobalBufferBytes, aggregate.bytes)
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
      maxBufferTicks: counter.maxBufferTicks,
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
    maxGlobalBufferTicks,
    maxGlobalBufferBytes,
    healthyGapMs,
    snapshotAgeSamplesMs,
    realignRequestedAtMs,
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
 *
 * 三个实测口径（2026-10-02 收紧，见模块头注）：
 *   - 年龄：`max(maxHealthyGap, max(snapshotAgeSamplesMs))`（分位在标定记录里单独给）
 *   - 缓冲：**全局**峰值条数/字节（不是单标的切片）
 *   - 重对齐：**一个回填窗口内的峰值需求**（`peakDemandInWindow`），不是总次数
 * @param base - 已确定的其他参数（阈值、下单预算等）。
 * @param scenarios - 场景集。
 * @param headroom - 余量倍数（默认 1.5）。
 */
export function calibrate(base: Omit<AlignmentParams, 'snapshotAgeBudgetMs' | 'bufferMaxTicks' | 'bufferMaxBytes' | 'realignTokenCapacity'>, scenarios: readonly (HarnessScenario | MultiSymbolScenario)[], headroom = 1.5): CalibrationResult {
  const refillPerSec = base.realignRefillPerSec > 0 ? base.realignRefillPerSec : 1
  const provisional: AlignmentParams = {
    ...base,
    snapshotAgeBudgetMs: 1_000_000,
    bufferMaxTicks: 1_000_000,
    bufferMaxBytes: 1_000_000_000,
    realignTokenCapacity: Math.max(1, ...scenarios.map((scenario) => scenario.snapshotBurst + 1)),
  }
  const measured = scenarios.map((scenario) => isMultiSymbolScenario(scenario) ? runMultiSymbolScenario(provisional, scenario) : runScenario(provisional, scenario))
  const maxBufferedTicks = Math.max(1, ...measured.map((metrics) => metrics.maxGlobalBufferTicks))
  const maxBufferedBytes = Math.max(BYTES_FLOOR, ...measured.map((metrics) => metrics.maxGlobalBufferBytes))
  const maxMeasuredAge = Math.max(1, ...measured.map((metrics) => Math.max(metrics.healthyGapMs, summarizeAgeSamples(metrics.snapshotAgeSamplesMs).max)))
  const maxRealignDemand = Math.max(1, ...measured.map((metrics) => peakDemandInWindow(metrics.realignRequestedAtMs, 1000 / refillPerSec)))
  const suggested: AlignmentParams = {
    ...base,
    snapshotAgeBudgetMs: Math.ceil(maxMeasuredAge * headroom),
    bufferMaxTicks: Math.ceil(maxBufferedTicks * headroom),
    bufferMaxBytes: Math.ceil(maxBufferedBytes * headroom),
    realignTokenCapacity: Math.ceil(maxRealignDemand * headroom),
  }
  return {
    suggested,
    measured,
    headroom,
    evidence: [
      'snapshotAgeBudgetMs = ceil(max(maxHealthyGap, maxSnapshotAge) ' + String(maxMeasuredAge) + ' x ' + String(headroom) + ') = ' + String(suggested.snapshotAgeBudgetMs),
      'bufferMaxTicks = ceil(maxGlobalBufferedTicks ' + String(maxBufferedTicks) + ' x ' + String(headroom) + ') = ' + String(suggested.bufferMaxTicks),
      'bufferMaxBytes = ceil(maxGlobalBufferedBytes ' + String(maxBufferedBytes) + ' x ' + String(headroom) + ') = ' + String(suggested.bufferMaxBytes),
      'realignTokenCapacity = ceil(maxRealignDemandPerWindow ' + String(maxRealignDemand) + ' x ' + String(headroom) + ') = ' + String(suggested.realignTokenCapacity),
    ],
  }
}

const BYTES_FLOOR = 128
