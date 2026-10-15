/**
 * 事件读取面：关键词检索与单事件详情——两条都只走 `GET /events` **一次**。
 *
 * 上游约束（2026-10-15 实测，原始证据 spikes/impl-polymarket/agent-tools-ACCEPTANCE.md）：
 *
 * 1. **`/events` 没有关键词检索参数**：`q=fed` 与 `title=fed` 返回与无参数**逐条相同**
 *    的结果集（默认排序 = event id 升序，头几条是 2022 年的冷门体育盘），服务端过滤
 *    不存在。因此关键词检索 = 单次拉「开盘中、24h 成交额降序」的一页，再本地过滤；
 *    输出必须显式带 `filtering: 'local-page-filter'`，绝不冒充上游检索。
 * 2. **`order` 默认升序**：`order=volume24hr` 单用会返回成交额 0 的盘；
 *    `order=volume24hr&ascending=false` 才是「热门前 N」（实测把 Fed Decision 排到第 2）。
 * 3. **`id=<n>` 与 `slug=<精确 slug>` 精确匹配**：命中回长度 1 的数组，命中不到回
 *    `[]`（200）。「200 空数组」是唯一合法的「没有这个事件」形态，据此抛
 *    TRADING_SYMBOL_NOT_FOUND，不与上游故障混淆。
 *
 * 档位标签口径与 FOMC 面同源（discovery.ts 的 `canonicalBucket`）：`groupItemTitle`
 * 优先，缺失时退到 `outcomes[0]`（二元盘就是 `Yes`/`No`）——两者都不存在才丢弃该档，
 * 宁可少一档也不编一个概率出来。
 */
import { canonicalBucket } from './discovery.js'
import { isRecord, num, parseNumberArray, parseTextArray, text } from './json.js'

/** 一个档位（市场）的规范化读数。 */
export interface EventBucketQuote {
  /** 稳定档位键（如 `no_change` / `dec_50plus`；未识别形态 = `raw:<原文>`）。 */
  readonly key: string
  /** 展示标签原文（`groupItemTitle`，缺失时退到 `outcomes[0]`）。 */
  readonly label: string
  /** 隐含概率 = `outcomePrices[0]`；解析不出则缺省（不猜）。 */
  readonly probability?: number | undefined
}

/** 检索结果里的一条事件（元数据 + 档位概率）。 */
export interface EventSummary {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly closed: boolean
  /** 上游 event `endDate`（ISO 8601 UTC）；缺失则缺省。 */
  readonly endDate?: string | undefined
  /** 累计成交额（上游 event `volume`，美元）。 */
  readonly volume?: number | undefined
  /** 盘口深度（上游 event `liquidity`，美元）。 */
  readonly liquidity?: number | undefined
  readonly buckets: readonly EventBucketQuote[]
}

/** 单市场详情里的一条档位/市场（保留上游原始报价维度）。 */
export interface EventMarketQuote {
  readonly key: string
  readonly label: string
  /** 上游 `question`（市场问句原文）。 */
  readonly question?: string | undefined
  /** 上游 `outcomes` 解析后的数组（如 `["Yes","No"]`）；解析不出则缺省。 */
  readonly outcomes?: readonly string[] | undefined
  /** 上游 `outcomePrices` 解析后的数组（与 {@link outcomes} 同序）；解析不出则缺省。 */
  readonly outcomePrices?: readonly number[] | undefined
  /** 最优买价（结算后上游为 null → 缺省）。 */
  readonly bestBid?: number | undefined
  /** 最优卖价。 */
  readonly bestAsk?: number | undefined
  /** 价差（上游 `spread`，缺省时由 bestAsk − bestBid 推得；两端缺失则缺省）。 */
  readonly spread?: number | undefined
  /** 盘口深度（上游 `liquidityNum`，美元）。 */
  readonly liquidity?: number | undefined
  /** 累计成交额（上游 `volumeNum`，美元）。 */
  readonly volume?: number | undefined
  /** 该市场是否已结算（上游 market `closed`）。 */
  readonly closed: boolean
  /** 是否仍可下单（上游 market `acceptingOrders`；**不用 `active` 判断**）。 */
  readonly acceptingOrders: boolean
}

/** 单个事件的详情。 */
export interface EventDetail {
  readonly id: string
  readonly slug: string
  readonly title: string
  readonly closed: boolean
  readonly endDate?: string | undefined
  /** 上游 event `negRisk`（互斥档位集合标记）。 */
  readonly negRisk: boolean
  readonly volume?: number | undefined
  readonly liquidity?: number | undefined
  readonly markets: readonly EventMarketQuote[]
}

/** 一页事件的关键词命中统计（`matched` 是**截断前**的命中数）。 */
export interface EventSearchPage {
  readonly scanned: number
  readonly matched: number
  readonly events: readonly EventSummary[]
}

/** 档位标签：`groupItemTitle` 优先，缺失时退到首个 outcome。 */
function bucketLabel(market: Record<string, unknown>): string | undefined {
  return text(market.groupItemTitle) ?? parseTextArray(market.outcomes)?.[0]
}

function parseBucketQuote(market: unknown): EventBucketQuote | undefined {
  if (!isRecord(market)) return undefined
  const label = bucketLabel(market)
  if (label === undefined) return undefined
  const probability = parseNumberArray(market.outcomePrices)?.[0]
  return { key: canonicalBucket(label).key, label, ...(probability !== undefined ? { probability } : {}) }
}

function parseMarketQuote(market: unknown): EventMarketQuote | undefined {
  if (!isRecord(market)) return undefined
  const label = bucketLabel(market)
  if (label === undefined) return undefined
  const question = text(market.question)
  const outcomes = parseTextArray(market.outcomes)
  const outcomePrices = parseNumberArray(market.outcomePrices)
  const bestBid = num(market.bestBid)
  const bestAsk = num(market.bestAsk)
  const upstreamSpread = num(market.spread)
  const spread = upstreamSpread ?? (bestBid !== undefined && bestAsk !== undefined ? Number((bestAsk - bestBid).toFixed(6)) : undefined)
  const liquidity = num(market.liquidityNum)
  const volume = num(market.volumeNum)
  return {
    key: canonicalBucket(label).key,
    label,
    ...(question !== undefined ? { question } : {}),
    ...(outcomes !== undefined ? { outcomes } : {}),
    ...(outcomePrices !== undefined ? { outcomePrices } : {}),
    ...(bestBid !== undefined ? { bestBid } : {}),
    ...(bestAsk !== undefined ? { bestAsk } : {}),
    ...(spread !== undefined ? { spread } : {}),
    ...(liquidity !== undefined ? { liquidity } : {}),
    ...(volume !== undefined ? { volume } : {}),
    closed: market.closed === true,
    acceptingOrders: market.acceptingOrders === true,
  }
}

/** 单条上游事件 → 检索摘要；缺 id/title/slug 的事件不算一条（不编）。 */
export function parseEventSummary(event: unknown): EventSummary | undefined {
  if (!isRecord(event)) return undefined
  const id = text(String(event.id ?? ''))
  const title = text(event.title)
  const slug = text(event.slug)
  if (id === undefined || title === undefined || slug === undefined) return undefined
  const endDate = text(event.endDate)
  const volume = num(event.volume)
  const liquidity = num(event.liquidity)
  const buckets: EventBucketQuote[] = []
  if (Array.isArray(event.markets)) {
    for (const market of event.markets) {
      const quote = parseBucketQuote(market)
      if (quote !== undefined) buckets.push(quote)
    }
  }
  return {
    id,
    title,
    slug,
    closed: event.closed === true,
    ...(endDate !== undefined ? { endDate } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(liquidity !== undefined ? { liquidity } : {}),
    buckets,
  }
}

/**
 * 关键词命中：事件标题或 slug（大小写不敏感子串）。
 *
 * **不搜档位标签**（2026-10-15 实测决定的边界）：把档位标签算进命中面后，
 * `fed` 会命中 `Ballon d'Or Winner 2026`——它的某个候选人是 `Federico ...`，
 * 子串 `fed` 合法命中。检索工具的价值在精度，「命中了一个人名」对问「有没有
 * 美联储相关盘口」的调用方是纯噪声。档位标签依然逐条回给调用方（`buckets`），
 * 只是不参与匹配。
 */
export function matchesKeyword(event: EventSummary, keyword: string): boolean {
  return `${event.title}\n${event.slug}`.toLowerCase().includes(keyword)
}

/**
 * 对**一页**上游事件做本地关键词过滤（上游没有检索参数，见本模块头注）。
 *
 * 非数组体抛 TypeError 而不返回空结果：上游把「参数错」和「真的没有数据」都表现成
 * 200（证据 Q5.2），这里只能在体形状上守边界。
 */
export function searchEventsInPage(payload: unknown, keyword: string, limit: number): EventSearchPage {
  if (!Array.isArray(payload)) {
    throw new TypeError('polymarket gamma /events: expected a JSON array of events')
  }
  const needle = keyword.toLowerCase()
  const summaries: EventSummary[] = []
  for (const event of payload) {
    const summary = parseEventSummary(event)
    if (summary !== undefined) summaries.push(summary)
  }
  const matched = summaries.filter((event) => matchesKeyword(event, needle))
  return { scanned: summaries.length, matched: matched.length, events: matched.slice(0, limit) }
}

function parseEventRecord(event: unknown): EventDetail | undefined {
  if (!isRecord(event)) return undefined
  const id = text(String(event.id ?? ''))
  const title = text(event.title)
  const slug = text(event.slug)
  if (id === undefined || title === undefined || slug === undefined) return undefined
  const endDate = text(event.endDate)
  const volume = num(event.volume)
  const liquidity = num(event.liquidity)
  const markets: EventMarketQuote[] = []
  if (Array.isArray(event.markets)) {
    for (const market of event.markets) {
      const quote = parseMarketQuote(market)
      if (quote !== undefined) markets.push(quote)
    }
  }
  return {
    id,
    slug,
    title,
    closed: event.closed === true,
    ...(endDate !== undefined ? { endDate } : {}),
    negRisk: event.negRisk === true,
    ...(volume !== undefined ? { volume } : {}),
    ...(liquidity !== undefined ? { liquidity } : {}),
    markets,
  }
}

/**
 * 单事件响应体 → 详情。
 *
 * `id=` / `slug=` 是精确匹配（实测最多一条），所以取首条可解析记录；
 * 返回 undefined = 上游 200 但空集（**没有这个事件**，调用方抛 TRADING_SYMBOL_NOT_FOUND），
 * 与「上游故障」是两件事，调用方不得把前者读成后者或反过来。
 */
export function parseEventDetail(payload: unknown): EventDetail | undefined {
  if (!Array.isArray(payload)) {
    throw new TypeError('polymarket gamma /events: expected a JSON array of events')
  }
  for (const event of payload) {
    const detail = parseEventRecord(event)
    if (detail !== undefined) return detail
  }
  return undefined
}
