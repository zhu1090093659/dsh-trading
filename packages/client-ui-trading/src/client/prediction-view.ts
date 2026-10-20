/**
 * Polymarket 面板的纯逻辑（无 React、无 IO）：质量标记、显示口径、健康检查、
 * 会话内采样时间轴与宏观事件对齐。抽成纯模块是为了让这些判据可离线复算——
 * 面板组件只负责取数编排与渲染。
 *
 * 三处口径的裁决来源（2026-10-11 owner 裁决，见
 * .agents/notes/implemented/feature/2026-10-11-polymarket-prediction-data-plane.md
 * §网页显示口径 vs 连接器口径）：
 *
 * - **显示概率取 `bestAsk`**，与 Polymarket 网页逐值一致（实测网页显示的就是买
 *   Yes 价；December No change 档 mid 0.225 vs 网页 0.23）。`bestAsk` 缺失（结算后
 *   上游为 null）时回落到 `probability`（mid），由 {@link probabilityBasisOf} 如实
 *   标注基准，不静默换口径。
 * - **事件对照一律取 mid**（连接器 `probability` 原值 = 上游 prices-history 的 `p`，
 *   与 gamma outcomePrices 等价）：「历史段」（按事件开窗回填）与会话段都只有这一个
 *   同源口径，混用 bestAsk 会拿两种口径相减。显示值与对照口径在面板上各自标注，
 *   不隐式换算。
 * - **Δ 沿用宿主快照的 `changeSincePrevious`**（mid 基准），与显示口径差半个 tick
 *   以内；缺省 = 不知道 → 不显示变动，绝不填 0 冒充「确知没变」。
 * - **深度/价差阈值是判断口径**，上游证据（spikes/impl-polymarket/）只给了实测分布
 *   （liquidityNum 87.9k–956k、spread 0.001–0.012），没有给阈值，故由 owner 定：
 *   深度 < 100k USD 记「深度不足」，价差 > 0.02 记「价差过宽」——两个独立标记，
 *   区分「没人挂单」与「点差太宽」两种不同的坏质量。
 */

import type { ClientPredictionBucket, ClientPredictionMeeting } from './api.ts'

/** 深度下限（美元）：低于此值视为噪声，显式标注而不是画成信号。 */
export const MIN_LIQUIDITY_USD = 100_000

/** 价差上限：实测最大 0.012，0.02 只拦真实异常。 */
export const MAX_SPREAD = 0.02

/**
 * 概率和的健康区间：实测正常区间约 [0.98, 1.03]。
 * **不假设严格等于 1**——2026-12 的 sum(bid) 实测 1.0040 > 1，且各档 spread 会
 * 让和天然偏离；越界只提示，绝不据此改写概率。
 */
export const SUM_MIN = 0.98
export const SUM_MAX = 1.03

/** 采样环形上限：面板常驻（右缘竖条页签），无上限会随会话时长无限增长。 */
export const MAX_SAMPLES = 240

/** 质量标记：两个独立维度，不用一个词混掉两种坏质量。 */
export type QualityMark = 'thin-depth' | 'wide-spread'

/**
 * 概率显示基准：`ask` = 上游 bestAsk（与网页一致）；`mid` = 回落值。
 * 回落只发生在结算后（bestBid 为 null、bestAsk 残留 0.001）或上游缺报价时。
 */
export type ProbabilityBasis = 'ask' | 'mid'

/** 深度/价差达标判据：未达标的一个标记各出一枚（缺字段不标记——「不知道」不是「不达标」）。 */
export function qualityMarksOf(bucket: Pick<ClientPredictionBucket, 'liquidity' | 'spread'>): readonly QualityMark[] {
  const marks: QualityMark[] = []
  if (bucket.liquidity !== undefined && bucket.liquidity < MIN_LIQUIDITY_USD) marks.push('thin-depth')
  if (bucket.spread !== undefined && bucket.spread > MAX_SPREAD) marks.push('wide-spread')
  return marks
}

/** 显示口径：bestAsk 可用则 ask，否则回落 mid（调用方据此标注基准）。 */
export function probabilityBasisOf(bucket: Pick<ClientPredictionBucket, 'bestAsk'>): ProbabilityBasis {
  return bucket.bestAsk === undefined ? 'mid' : 'ask'
}

/**
 * 显示概率（0..1）。
 *
 * 与连接器下发的 `probability`（= mid，与 CLOB midpoint 逐值相等）**刻意不同源**：
 * 面板要能与 Polymarket 网页抽查逐值对上，网页显示的是 ask。两个口径都在面板上
 * 有明确出口（显示值取 ask、Δ 取宿主快照的 mid 基准），不存在隐式换算。
 */
export function displayProbabilityOf(bucket: Pick<ClientPredictionBucket, 'bestAsk' | 'probability'>): number {
  return bucket.bestAsk === undefined ? bucket.probability : bucket.bestAsk
}

/** 概率和是否越界（越界 = 提示，不是改写）。 */
export function sumHealthOf(sum: number): 'ok' | 'off-band' {
  return sum < SUM_MIN || sum > SUM_MAX ? 'off-band' : 'ok'
}

/** 概率（0..1）→ 百分比文本（一位小数；越界值原样显示，便于发现问题）。 */
export function formatProbability(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/**
 * 变动文本（概率单位 → 百分点）。
 *
 * `undefined` 缺省返回 `undefined`（= 快照不足，不显示变动）。**绝不返回 `+0.0pp`**：
 * 0 表示「确知没变」，而缺省表示「不知道」，把后者画成前者是编造。
 */
export function formatDeltaPp(delta: number | undefined): string | undefined {
  if (delta === undefined) return undefined
  const pp = delta * 100
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)}pp`
}

/* ------------------------------------------------------------------ */
/* 会话内采样时间轴                                                       */
/* ------------------------------------------------------------------ */

/** 一次采样的各档显示概率（bucket key → 0..1）。 */
export interface ProbabilitySample {
  /** 采样时刻（epoch ms；审计与事件对齐都靠它）。 */
  readonly at: number
  readonly values: Readonly<Record<string, number>>
}

/** 追加采样并裁到上限（保留最新）。 */
export function appendSample(
  samples: readonly ProbabilitySample[],
  sample: ProbabilitySample,
  max: number = MAX_SAMPLES,
): readonly ProbabilitySample[] {
  const next = [...samples, sample]
  return next.length > max ? next.slice(next.length - max) : next
}

/** 跨事件的概率位移。 */
export interface Movement {
  readonly before: number
  readonly beforeAt: number
  readonly after: number
  readonly afterAt: number
  readonly delta: number
}

/**
 * 某档位跨 `at` 那一刻的位移：取 `at` 之前最近一次与之后最近一次的读数。
 *
 * **两侧任一缺失即返回 `undefined`**（而不是拿单侧硬算或填 0）：面板打开前的
 * 事件没有「之前」那一段，本仓纪律是显示「采样不足」而不是显示 0 变动。
 */
export function movementAround(
  samples: readonly ProbabilitySample[],
  at: number,
  key: string,
): Movement | undefined {
  let before: { value: number; at: number } | undefined
  let after: { value: number; at: number } | undefined
  for (const sample of samples) {
    const value = sample.values[key]
    if (value === undefined) continue
    if (sample.at <= at) before = { value, at: sample.at }
    else if (after === undefined) after = { value, at: sample.at }
  }
  if (before === undefined || after === undefined) return undefined
  return { before: before.value, beforeAt: before.at, after: after.value, afterAt: after.at, delta: after.value - before.value }
}

/**
 * 跨 `at` 位移最大的档位（事件对照视图的主行）：位移相同取档位顺序靠前者。
 * 全部档位都无法对照 → `undefined`。
 */
export function largestMovementAround(
  samples: readonly ProbabilitySample[],
  at: number,
  keys: readonly string[],
): { readonly key: string; readonly movement: Movement } | undefined {
  let best: { key: string; movement: Movement } | undefined
  for (const key of keys) {
    const movement = movementAround(samples, at, key)
    if (movement === undefined) continue
    if (best === undefined || Math.abs(movement.delta) > Math.abs(best.movement.delta)) best = { key, movement }
  }
  return best
}

/* ------------------------------------------------------------------ */
/* 宏观事件对齐                                                          */
/* ------------------------------------------------------------------ */

/** 美国通胀类公布事件（CPI/PPI）——本面板要对照的就是这类时点。 */
export interface InflationEvent {
  readonly at: number
  readonly title: string
}

/**
 * 上游日历条目 → 美国通胀事件时点（升序）。
 *
 * 匹配 `region === '美国'` 且标题含 CPI/PPI；上游标题是中文（如「美国9月核心CPI年率」），
 * 区域名是上游数据词汇而非 UI 文案。公布时刻解析失败的行直接丢弃（不猜时间）。
 */
export function inflationEventsOf(
  entries: readonly { readonly publishedAt: string; readonly title: string; readonly region: string }[],
): readonly InflationEvent[] {
  const events: InflationEvent[] = []
  for (const entry of entries) {
    if (entry.region !== US_REGION) continue // i18n-allow: 区域名是上游数据词汇（与条目 region 比对），非 UI 文案
    if (!INFLATION_TITLE_RE.test(entry.title)) continue
    const at = Date.parse(entry.publishedAt)
    if (!Number.isFinite(at)) continue
    events.push({ at, title: entry.title })
  }
  return events.sort((a, b) => a.at - b.at)
}

/** 美国区域名（上游数据词汇）。 */
const US_REGION = '美国' // i18n-allow: 上游数据词汇

/** 通胀类标题匹配（CPI/PPI 是国际通用缩写，与上游英文缩写同形）。 */
const INFLATION_TITLE_RE = /CPI|PPI/

/* ------------------------------------------------------------------ */
/* 上游历史回填（事件前后各 24h、5 分钟口径）                               */
/* ------------------------------------------------------------------ */

/** 事件前后各 24h 的回填窗口。 */
export const HISTORY_WINDOW_MS = 24 * 3600_000

/** 上游最小间隔（分钟）：5 分钟是 prices-history 能给到的最细档。 */
export const HISTORY_FIDELITY_MINUTES = 5

/** 上游历史只保留约 30 天：更早的事件回填必定为空，不进候选。 */
export const HISTORY_MAX_AGE_MS = 30 * 86400_000

/**
 * 事件回填窗口 `[eventAt - 24h, min(eventAt + 24h, now)]`。
 *
 * 右端夹到 now（未来那段上游没有数据）；`toMs <= fromMs` 也照常返回——是否真的
 * 发请求由调用方决定，这里只保证两个端点都是有限数、不产生 NaN。
 */
export function historyWindowOf(eventAt: number, now: number): { readonly fromMs: number; readonly toMs: number } {
  return { fromMs: eventAt - HISTORY_WINDOW_MS, toMs: Math.min(eventAt + HISTORY_WINDOW_MS, now) }
}

/**
 * 可回填的候选事件：已公布（`at <= now`）且在上游历史保留期内（30 天），
 * 按 `at` 降序（最近公布在前）。未来事件与超期事件都不进候选——回填它们必定为空。
 */
export function candidateEventsOf(events: readonly InflationEvent[], now: number): readonly InflationEvent[] {
  return events
    .filter((event) => event.at <= now && event.at >= now - HISTORY_MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
}

/**
 * 上游历史 → 采样时间轴：键 `${meetingId}:${bucketKey}`、`at = t * 1000`（上游
 * `t` 是 unix 秒）、值 `p`（mid）。
 *
 * 同一时刻的多个档位合成**一条**采样：与会话采样的粒度一致，合并时才能整条快照覆盖，
 * 而不是逐档位互相顶掉。空 series → 空数组（不抛；调用方据此判「上游历史不覆盖」）。
 *
 * 各档的 `t` 不保证落在同一网格（上游按各 token 的成交时刻出点）：不在同一时刻的档位
 * 落在不同采样里，每条 values 只带自己那个键。**对照仍然成立**——{@link movementAround}
 * 对每个 key 独立取「`at` 之前最近一条带该键的采样」与「之后最近一条带该键的采样」，
 * 从不跨键插值，也不要求两档同时刻；唯一前提是采样序列按 `at` 升序，本函数与
 * {@link mergeSamples} 都排序，面板只把合并结果交给对照判据。
 */
export function samplesFromHistory(history: {
  readonly meetingId: string
  readonly series: readonly {
    readonly bucketKey: string
    readonly points: readonly { readonly t: number; readonly p: number }[]
  }[]
}): readonly ProbabilitySample[] {
  const byAt = new Map<number, Record<string, number>>()
  for (const series of history.series) {
    const key = `${history.meetingId}:${series.bucketKey}`
    for (const point of series.points) {
      const at = point.t * 1000
      const values = byAt.get(at) ?? {}
      values[key] = point.p
      byAt.set(at, values)
    }
  }
  return [...byAt.entries()].sort((a, b) => a[0] - b[0]).map(([at, values]) => ({ at, values }))
}

/**
 * 合并两条采样时间轴：按 `at` 升序，同一 `at` 后者覆盖前者（调用方传参顺序即优先级：
 * 会话段在后，同一时刻以会话读数为准）；按 `max` 裁尾保留最新。
 */
export function mergeSamples(
  a: readonly ProbabilitySample[],
  b: readonly ProbabilitySample[],
  max: number = MAX_SAMPLES,
): readonly ProbabilitySample[] {
  const byAt = new Map<number, ProbabilitySample>()
  for (const sample of a) byAt.set(sample.at, sample)
  for (const sample of b) byAt.set(sample.at, sample)
  const merged = [...byAt.values()].sort((x, y) => x.at - y.at)
  return merged.length > max ? merged.slice(merged.length - max) : merged
}

/** 事件对照判据：两侧都有读数才 `comparable`，否则 `insufficient`。 */
export type EventComparison =
  | { readonly state: 'comparable'; readonly key: string; readonly movement: Movement }
  | { readonly state: 'insufficient' }

/**
 * 跨 `at` 位移最大的档位（复用 {@link largestMovementAround}）。单侧缺失即
 * `insufficient`——**绝不拿单侧硬算或填 0**。
 *
 * 三态里的第三态（`uncovered` = 上游历史不覆盖该时点）不进纯函数：它判的是「回填
 * 是否为空」这个取数事实，由面板结合回填结果决定。
 */
export function eventComparisonOf(
  samples: readonly ProbabilitySample[],
  at: number,
  keys: readonly string[],
): EventComparison {
  const hit = largestMovementAround(samples, at, keys)
  return hit === undefined ? { state: 'insufficient' } : { state: 'comparable', key: hit.key, movement: hit.movement }
}

/* ------------------------------------------------------------------ */
/* 面板视图模型                                                          */
/* ------------------------------------------------------------------ */

/** 单个档位的展示行。 */
export interface BucketView {
  readonly key: string
  /** 上游档位标签原文（展示用，不做改写）。 */
  readonly label: string
  /** 利率变动（bps；未识别形态 = undefined，不猜）。 */
  readonly changeBps: number | undefined
  readonly probability: number
  /**
   * 上游 `probability` 原值（= mid，与 prices-history 的 `p` 同源）。
   * 事件对照与会话采样用它；主表显示仍用 {@link BucketView.probability}（bestAsk）。
   */
  readonly midProbability: number
  readonly basis: ProbabilityBasis
  readonly marks: readonly QualityMark[]
  /** 变动（百分点单位由渲染层格式化）；缺省 = 快照不足。 */
  readonly delta: number | undefined
  readonly closed: boolean
}

/** 一场会议的展示行。 */
export interface MeetingView {
  readonly id: string
  readonly title: string
  readonly meetingWindow: string | undefined
  readonly endDate: string
  readonly closed: boolean
  readonly probabilitySum: number
  readonly sumHealth: 'ok' | 'off-band'
  readonly degraded: readonly string[]
  readonly buckets: readonly BucketView[]
}

/**
 * 会议 → 展示模型。上游字段缺省一律保留为缺省（不补 0、不补空串），
 * 让「上游没给」与「上游给了 0」在渲染层可区分。
 */
export function meetingViewOf(meeting: ClientPredictionMeeting): MeetingView {
  return {
    id: meeting.id,
    title: meeting.title,
    meetingWindow: meeting.meetingWindow,
    endDate: meeting.endDate,
    closed: meeting.closed,
    probabilitySum: meeting.probabilitySum,
    sumHealth: sumHealthOf(meeting.probabilitySum),
    degraded: meeting.degraded,
    buckets: meeting.buckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      changeBps: bucket.changeBps,
      probability: displayProbabilityOf(bucket),
      midProbability: bucket.probability,
      basis: probabilityBasisOf(bucket),
      marks: qualityMarksOf(bucket),
      delta: bucket.changeSincePrevious,
      closed: bucket.closed,
    })),
  }
}

/**
 * 「下一次会议」= 第一场未结算的会议（上游按 endDate 升序下发）。
 * 全部已结算 → `undefined`（面板显示已结算态，不假装还有下一场）。
 */
export function nextMeetingOf(meetings: readonly ClientPredictionMeeting[]): ClientPredictionMeeting | undefined {
  return meetings.find((meeting) => !meeting.closed)
}

/** 上屏会议的场上限：下一次 + 后续至多两次（spike 判据里同批可用的后续会议）。 */
export const VISIBLE_MEETINGS = 3

/**
 * 上屏会议组：未结算会议按上游顺序（endDate 升序）取前 {@link VISIBLE_MEETINGS} 场。
 *
 * 为什么不止一场：尾部档位（50+ bps 这类）在最近一场常常深度充足，而真正的
 * 低深度形态出现在往后几次会议——只看一场就看不到「深度不足」的标注，也看不到
 * 市场对更远路径的押注。
 */
export function visibleMeetingsOf(meetings: readonly ClientPredictionMeeting[]): readonly ClientPredictionMeeting[] {
  return meetings.filter((meeting) => !meeting.closed).slice(0, VISIBLE_MEETINGS)
}
