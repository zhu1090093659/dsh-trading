/**
 * FOMC 决议市场的**发现规则与解析**——逐条实现 spikes/impl-polymarket/EVIDENCE.md
 * 钉死的判据（Q1/Q4），不另起一套猜法。
 *
 * 分层规则（每层都留痕，便于定位「下一次会议换 slug 后为何静默失效」）：
 *   L0 取候选   GET /events?series_id=35（FOMC 决议系列；`tag_slug=fomc` 只作交叉比对）
 *   L1 系列校验 保留内嵌 `series[].id === "35"` 的事件
 *   L2 标题正则 `Fed decision in <Month>?` / `Fed Interest Rates: <Month> <YYYY>`
 *   L3 形状     `negRisk === true` 且档位数在 4..6
 *   L4 噪声排除 slug/ticker 命中已知噪声清单则丢弃（纵深防御）
 *   L5 归一     按 event id 去重、按 endDate 升序
 *
 * 为什么判据是 `series[].id` 而不是 slug/seriesSlug（证据 Q1.2/Q1.3）：
 * - `seriesSlug` 在 2026-03 之前的事件上停更为 `fed-interest-rates`，按 slug 过滤会漏历史；
 * - 决议事件 slug 带 17 位随机后缀，且后缀是**建盘日**（2027-01 会议是
 *   `fed-decision-in-january-20260729233815502`），按前缀当成会议月必然出错。
 *
 * 上层还有两道不变量（证据 Q4，都是实测踩出来的）：
 * - 概率取 gamma `outcomePrices[0]`，**不自算** (bestBid+bestAsk)/2——结算后
 *   `bestBid` 变 null 而 `bestAsk` 残留 0.001，自算会得到 0.0005 这种无意义值；
 * - 判断「是否还在交易」用 market 级 `closed`/`acceptingOrders`，**不用 `active`**
 *   ——结算后 `active` 仍为 true。
 *
 * 回填定位键（2026-10-15 事件窗口回填）：`clobTokenIds` 是**字符串化 JSON 数组**，
 * 第 0 个元素与 `outcomePrices[0]` 同档（已核实 raw/06-events-series_id35.json）。
 * 解析不出就**不填**——绝不猜 token，猜错等于把一档的价格线画到另一档上。
 */
import type { PredictionMeeting, PredictionOutcomeBucket } from '@dshtrading/api'
import { isRecord, num, parseStringArray, text } from './json.js'

/** 判据来源系列：FOMC 决议（证据 Q1.2，39/39 命中、噪声 0）。 */
export const FOMC_SERIES_ID = '35'

/**
 * `tag_slug=fomc` 上的已知噪声（L1 已全部排除，本表是纵深防御并记录失效模式）。
 * 来源：证据 Q1.1 的 6 条噪声 + probe-discovery.mjs 的全历史复核清单。
 */
export const NOISE_SLUGS: readonly string[] = [
  'how-many-fed-rate-hikes-in-2026',
  'warsh-out-as-fed-chair-by',
  'trump-tries-to-fire-warsh-in-2026',
  'fed-decisions-',
  'no-change-or-hike-25-bps-favored-on-october-27',
  'fed-rate-hike-by',
  'what-will-be-the-next-fed-rate-change',
  'dissent-at-fed-meeting',
  'powell-bingo',
  'what-will-powell-say',
  'what-will-kevin-warsh-say',
  'powell-says-',
]

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'] as const

/** 现代标题形态（2024-12 起）：`Fed decision in October?`。 */
const TITLE_MODERN = new RegExp(`^Fed decision in (${MONTHS.join('|')})\\?$`, 'i')
/** 历史标题形态（2022-03 起）：`Fed Interest Rates: June 2024`。 */
const TITLE_LEGACY = new RegExp(`^Fed Interest Rates:? (${MONTHS.join('|')}) \\d{4}$`, 'i')

/** 档位形状边界（证据 Q1.6：历史上有 4/5/6 三档形态，超出即非决议档位集合）。 */
export const MIN_BUCKETS = 4
export const MAX_BUCKETS = 6

/**
 * 各档概率之和的正常区间（证据 Q4.2：实测偏离 −0.0015 ~ +0.0155）。
 * **不假设严格等于 1**——2026-12 的 `sum(bid)` 实测为 1.0040 > 1，硬约束会假红。
 */
export const PROBABILITY_SUM_MIN = 0.98
export const PROBABILITY_SUM_MAX = 1.03

/** 会议日程解析（上游 description 原文：`its meeting scheduled for October 27-28, 2026`）。 */
const MEETING_WINDOW_RE = /meeting scheduled for ([A-Z][a-z]+ \d+(?:-\d+)?, \d{4})/

/** 档位标签 → 稳定键与利率变动（证据 Q1.7：标签在大小写与 `+` 上会漂移）。 */
export function canonicalBucket(label: string): { key: string; changeBps: number | undefined } {
  const value = label.trim()
  if (/^no change$/i.test(value)) return { key: 'no_change', changeBps: 0 }
  const match = /^(\d+)\+? bps (decrease|increase)$/i.exec(value)
  if (match) {
    const magnitude = Number(match[1])
    const up = /increase/i.test(match[2] ?? '')
    return {
      key: `${up ? 'inc' : 'dec'}_${match[1]}${value.includes('+') ? 'plus' : ''}`,
      changeBps: up ? magnitude : -magnitude,
    }
  }
  // 未识别形态（如 `Other`）保留原文可读性，变动值留空而不是猜 0。
  return { key: `raw:${value}`, changeBps: undefined }
}

function titleMatches(title: string): boolean {
  return TITLE_MODERN.test(title) || TITLE_LEGACY.test(title)
}

function hasSeries(event: Record<string, unknown>): boolean {
  if (!Array.isArray(event.series)) return false
  return event.series.some((entry) => isRecord(entry) && String(entry.id) === FOMC_SERIES_ID)
}

/** `outcomePrices` 是**字符串化的 JSON 数组**（如 `"[\"0.0035\",\"0.9965\"]"`）。 */
function parseOutcomePrices(value: unknown): number | undefined {
  const parsed = parseStringArray(value)
  if (parsed === undefined || parsed.length === 0) return undefined
  return num(parsed[0])
}

/**
 * `clobTokenIds` → 第 0 个 token（Yes 档，与 `outcomePrices[0]` 同档）。
 *
 * 上游把数组装成字符串（`"[\"706…\",\"528…\"]"`），与 `outcomePrices` 同一种包装；
 * 缺省/非字符串/不是数组/首元素不是非空字符串一律返回 undefined（不填，不猜）。
 */
function parseClobTokenId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined
  return text(parsed[0])
}

function parseBucket(market: Record<string, unknown>): PredictionOutcomeBucket | undefined {
  const label = text(market.groupItemTitle)
  const probability = parseOutcomePrices(market.outcomePrices)
  // 缺标签或缺概率的档位直接丢弃：宁可少一档，也不编一个概率出来。
  if (label === undefined || probability === undefined) return undefined
  const { key, changeBps } = canonicalBucket(label)
  const bestBid = num(market.bestBid)
  const bestAsk = num(market.bestAsk)
  const liquidity = num(market.liquidityNum)
  const volume = num(market.volumeNum)
  const volume24h = num(market.volume24hr)
  const tickSize = num(market.orderPriceMinTickSize)
  const clobTokenId = parseClobTokenId(market.clobTokenIds)
  return {
    key,
    label,
    ...(changeBps !== undefined ? { changeBps } : {}),
    probability,
    ...(bestBid !== undefined ? { bestBid } : {}),
    ...(bestAsk !== undefined ? { bestAsk } : {}),
    ...(bestBid !== undefined && bestAsk !== undefined ? { spread: Number((bestAsk - bestBid).toFixed(6)) } : {}),
    ...(liquidity !== undefined ? { liquidity } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(volume24h !== undefined ? { volume24h } : {}),
    ...(tickSize !== undefined ? { tickSize } : {}),
    ...(clobTokenId !== undefined ? { clobTokenId } : {}),
    acceptingOrders: market.acceptingOrders === true,
    closed: market.closed === true,
  }
}

/** 档位排序：按利率变动从低到高，未识别形态排末位（用 key 兜底保证确定性）。 */
function compareBuckets(a: PredictionOutcomeBucket, b: PredictionOutcomeBucket): number {
  const left = a.changeBps
  const right = b.changeBps
  if (left === undefined && right === undefined) return a.key.localeCompare(b.key)
  if (left === undefined) return 1
  if (right === undefined) return -1
  return left - right
}

/**
 * 单场会议 → 契约形状（含健康标记）。
 *
 * 返回 undefined = 该事件形状不足以构成一次决议（L3 之外的残形），由调用方丢弃。
 */
export function parseMeeting(event: Record<string, unknown>): PredictionMeeting | undefined {
  const id = text(String(event.id ?? ''))
  const slug = text(event.slug)
  const title = text(event.title)
  const endDate = text(event.endDate)
  if (id === undefined || slug === undefined || title === undefined || endDate === undefined) return undefined
  if (!Array.isArray(event.markets)) return undefined
  const buckets: PredictionOutcomeBucket[] = []
  for (const raw of event.markets) {
    if (!isRecord(raw)) continue
    const bucket = parseBucket(raw)
    if (bucket !== undefined) buckets.push(bucket)
  }
  if (buckets.length === 0) return undefined
  buckets.sort(compareBuckets)

  const sum = Number(buckets.reduce((acc, bucket) => acc + bucket.probability, 0).toFixed(6))
  const degraded: string[] = []
  if (sum < PROBABILITY_SUM_MIN || sum > PROBABILITY_SUM_MAX) degraded.push('probability-sum-out-of-band')
  if (buckets.some((bucket) => bucket.probability < 0 || bucket.probability > 1)) degraded.push('probability-out-of-range')
  if (buckets.some((bucket) => !bucket.closed && (bucket.bestBid === undefined || bucket.bestAsk === undefined))) {
    degraded.push('bucket-quote-missing')
  }
  if (buckets.some((bucket) => bucket.key.startsWith('raw:'))) degraded.push('bucket-unrecognized-label')

  const description = text(event.description)
  const window = description === undefined ? undefined : MEETING_WINDOW_RE.exec(description)
  return {
    id,
    slug,
    title,
    endDate,
    ...(window?.[1] !== undefined ? { meetingWindow: window[1] } : {}),
    closed: event.closed === true,
    buckets,
    probabilitySum: sum,
    degraded,
  }
}

export interface DiscoveryTrace {
  /** 上游返回的候选事件数。 */
  readonly candidates: number
  /** 各层后剩余条数（L1..L4）。 */
  readonly layers: { readonly series: number; readonly title: number; readonly shape: number; readonly noise: number }
  /** 各层丢弃的标题（诊断用，不参与业务）。 */
  readonly dropped: readonly string[]
}

export interface DiscoveryResult {
  readonly meetings: readonly PredictionMeeting[]
  readonly trace: DiscoveryTrace
}

/**
 * 应用 L1..L5。输入为**已解析的 JSON 体**（不是 HTTP 层），便于离线复核历史证据。
 *
 * 形状错误一律抛错而**不返回空数组**：上游把「参数/路径错」和「真的没有数据」
 * 都表现成 200（`tag_slug` 不存在 → 200 `[]`，证据 Q5.2），这里只能在体形状上守住
 * 边界——非数组体 = 契约破损，必须响亮。
 */
export function discoverFomcMeetings(payload: unknown): DiscoveryResult {
  if (!Array.isArray(payload)) {
    throw new TypeError('polymarket gamma /events: expected a JSON array of events')
  }
  const candidates = payload.filter(isRecord)
  const dropped: string[] = []

  const bySeries = candidates.filter((event) => {
    const ok = hasSeries(event)
    if (!ok) dropped.push(`L1:${String(event.title ?? event.slug ?? '(untitled)')}`)
    return ok
  })
  const byTitle = bySeries.filter((event) => {
    const ok = titleMatches(String(event.title ?? ''))
    if (!ok) dropped.push(`L2:${String(event.title ?? '(untitled)')}`)
    return ok
  })
  const byShape = byTitle.filter((event) => {
    const count = Array.isArray(event.markets) ? event.markets.length : 0
    const ok = event.negRisk === true && count >= MIN_BUCKETS && count <= MAX_BUCKETS
    if (!ok) dropped.push(`L3:${String(event.title ?? '(untitled)')}`)
    return ok
  })
  const byNoise = byShape.filter((event) => {
    const haystack = `${String(event.slug ?? '')} ${String(event.ticker ?? '')}`
    const hit = NOISE_SLUGS.find((noise) => haystack.includes(noise))
    if (hit !== undefined) dropped.push(`L4:${String(event.title ?? '(untitled)')}<-${hit}`)
    return hit === undefined
  })

  const deduped = new Map<string, PredictionMeeting>()
  for (const event of byNoise) {
    const meeting = parseMeeting(event)
    if (meeting !== undefined) deduped.set(meeting.id, meeting)
  }
  const meetings = [...deduped.values()].sort((a, b) => {
    const diff = Date.parse(a.endDate) - Date.parse(b.endDate)
    return diff !== 0 ? diff : a.id.localeCompare(b.id)
  })

  return {
    meetings,
    trace: {
      candidates: candidates.length,
      layers: { series: bySeries.length, title: byTitle.length, shape: byShape.length, noise: byNoise.length },
      dropped,
    },
  }
}
