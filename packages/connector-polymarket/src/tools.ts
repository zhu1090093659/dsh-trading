/**
 * agent 工具面（市场无关命名；预测市场是跨市场信息源，归 base bundle 的 host 行）。
 *
 * 只读边界（硬约束）：三个工具全部走 `PolymarketService` 的读取面 → gamma `GET /events`
 * 一次请求；**没有任何下单/撤单/改参数能力**，也没有第二份取数逻辑（工具与桥
 * `/dshtrading/api/prediction/fomc` 共用 apply() 里构造的那一个 service 实例）。
 *
 * 输出纪律：
 *   - 每条结果都带 `observedAt`（本进程取数时刻）、`source`（上游读取面）、`stale`
 *     （共享 CDN 是否直接命中；false 的含义是「没有缓存命中的证据」，不是「已证明实时」）；
 *   - 缺值一律**省略**而不是填 0：`changeSincePrevious` 缺失 = 不知道变没变，
 *     与「确知没变」是两件事；
 *   - 上游失败（403 Cloudflare 1010 / 非 JSON / 网络）结构化抛出，绝不回落成空数据；
 *     空数组只代表上游确实回了空集合这一种语义。
 */
import { defineTool, type InferValue, type JsonValueSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { POLYMARKET_SOURCE, PREDICTION_SEARCH_DEFAULT_LIMIT, PREDICTION_SEARCH_MAX_LIMIT, type PolymarketService } from './service.js'

/** 官方 jsonOutput 形态：声明完整 value schema + 紧凑 JSON render（与 base / jin10 同款）。 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S) {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}

/**
 * 类型级桥：连接器返回的是 JSON 载荷，但带可选字段、没有索引签名，结构上不满足 SDK 的
 * JsonValue。运行时校验与渲染仍走同一 schema；这里只消除类型层的结构失配，不做任何值变换。
 */
function jsonPayload<T>(value: T): InferValue<JsonValueSchemaSpec> {
  return value as InferValue<JsonValueSchemaSpec>
}

function jsonItems<T>(values: readonly T[]): Array<InferValue<JsonValueSchemaSpec>> {
  return values as unknown as Array<InferValue<JsonValueSchemaSpec>>
}

const freshnessProperties = {
  observedAt: { type: 'string' as const, required: true as const, description: 'Fetch instant recorded by this process (ISO 8601 UTC) — the upstream returns no response-level timestamp.' },
  source: { type: 'string' as const, required: true as const, description: `Upstream read surface: ${POLYMARKET_SOURCE}.` },
  stale: { type: 'boolean' as const, required: true as const, description: 'True when the response came straight from the shared CDN cache (cf-cache-status: HIT), i.e. a copy up to 5 minutes old. False means "no cache hit observed", not "proven live".' },
}

/** 每个工具的收尾一句：三件套的语义对模型可见（模型据此判断数据有多新）。 */
const FRESHNESS_NOTE =
  ' Every response carries observedAt (the fetch instant), source (the upstream read surface) and '
  + 'stale (true when the payload came straight from the shared 5-minute CDN cache — a copy, not necessarily live).'

const fomcOutput = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...freshnessProperties,
    meetings: { type: 'array' as const, items: { type: 'json' as const }, required: true as const },
  },
})

const searchOutput = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...freshnessProperties,
    filtering: { type: 'string' as const, const: 'local-page-filter' as const, required: true as const, description: 'This result is a LOCAL filter over one upstream page — /events has no keyword parameter.' },
    pageLimit: { type: 'number' as const, required: true as const, description: 'Size of the single upstream page scanned (100 = upstream maximum).' },
    scanned: { type: 'number' as const, required: true as const, description: 'Upstream events scanned in that page.' },
    matched: { type: 'number' as const, required: true as const, description: 'Keyword matches before truncation to the requested limit.' },
    events: { type: 'array' as const, items: { type: 'json' as const }, required: true as const },
  },
})

const detailOutput = jsonOutput({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...freshnessProperties,
    event: { type: 'json' as const, required: true as const },
  },
})

/**
 * 工具集合：service 注入即得全部工具（与桥共用同一实例，生产/测试同一路径）。
 *
 * 入参一律 ≤3 个（模型可预测的接口面）；每次调用只发一次 gamma 请求（实测上限 100 条
 * 一页，不翻页、不新增速率预算）。
 */
export function createPolymarketTools(service: PolymarketService): Array<ReturnType<typeof defineTool>> {
  return [
    defineTool({
      name: 'prediction_fomc_meetings',
      description:
        'Read-only FOMC decision odds from the Polymarket prediction market (public API, no key). '
        + 'Returns every FOMC decision event on the Fed rates path — open and already resolved — with one entry per rate-change bucket: '
        + 'canonical key (no_change / inc_25 / dec_50plus …), label as quoted upstream, implied probability (= upstream outcomePrices[0]) and best bid/ask. '
        + 'changeSincePrevious appears only when a local snapshot from an earlier fetch exists; when it is absent the difference is UNKNOWN, never zero. '
        + 'The probability probed here is the same value the panel bridge /dshtrading/api/prediction/fomc publishes. '
        + 'Pass meetingId (event id or slug) to narrow the response to one meeting. Read-only: this tool cannot place, cancel or modify anything.'
        + FRESHNESS_NOTE,
      parameters: {
        meetingId: { type: 'string', description: 'Optional FOMC meeting selector: the Polymarket event id (e.g. 606422) or its exact slug. Omit for all meetings.' },
      },
      output: fomcOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const meetingId = typeof args.meetingId === 'string' && args.meetingId.trim() !== '' ? args.meetingId.trim() : undefined
        const result = await service.fomcMeetings(meetingId !== undefined ? { meetingId } : {})
        return { observedAt: result.observedAt, source: result.source, stale: result.stale, meetings: jsonItems(result.meetings) }
      },
    }),
    defineTool({
      name: 'prediction_search_events',
      description:
        'Read-only keyword search over Polymarket prediction market events (public API, no key). '
        + 'IMPORTANT: the upstream /events endpoint has NO keyword parameter, so this is NOT an upstream search — the tool fetches ONE page of the 100 most active OPEN events (24h volume descending) and filters it locally. '
        + 'The response always reports filtering="local-page-filter", the scanned page size and the pre-truncation match count, so you can tell "nothing matched the keyword" from "the keyword exists but is not on this page". '
        + 'Matching is a case-insensitive substring of the event title or slug — outcome labels are returned per hit but are not searched. '
        + 'Each hit carries id, title, slug, closed, endDate, volume, liquidity and its rate/outcome buckets with implied probabilities; call prediction_event_detail with an id or slug for the full quote. '
        + 'Use it for prediction-market exposure around macro, election, crypto or policy questions; for Fed rate odds prefer prediction_fomc_meetings (serie-complete). '
        + 'Read-only: this tool cannot place, cancel or modify anything.'
        + FRESHNESS_NOTE,
      parameters: {
        keyword: { type: 'string', required: true as const, description: 'Keyword, Chinese or English: case-insensitive substring of the event title or slug (outcome labels are returned per hit but are NOT searched), e.g. fed / recession / bitcoin / 降息 / 大选.' },
        limit: { type: 'number', description: `Max matches to return (integer 1..${PREDICTION_SEARCH_MAX_LIMIT}; default ${PREDICTION_SEARCH_DEFAULT_LIMIT}).` },
      },
      output: searchOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const limit = readLimit(args.limit, PREDICTION_SEARCH_DEFAULT_LIMIT, PREDICTION_SEARCH_MAX_LIMIT)
        const result = await service.searchEvents({ keyword: String(args.keyword ?? ''), limit })
        return {
          observedAt: result.observedAt,
          source: result.source,
          stale: result.stale,
          filtering: result.filtering,
          pageLimit: result.pageLimit,
          scanned: result.scanned,
          matched: result.matched,
          events: jsonItems(result.events),
        }
      },
    }),
    defineTool({
      name: 'prediction_event_detail',
      description:
        'Read-only detail for ONE Polymarket prediction event (public API, no key): title, closed, endDate, event-level negRisk, and every market in it with '
        + 'outcomes / outcomePrices (parsed arrays, same order — outcomePrices[0] is P(outcomes[0]), normally the "Yes" leg), bestBid, bestAsk, spread, liquidityNum and volumeNum. '
        + 'Event-level volume/liquidity aggregate the whole event. Resolved markets keep closed=true; bestBid may be absent after settlement (upstream null) — absent means unknown, not zero. '
        + 'One request per call. An id or slug the upstream does not know fails explicitly (TRADING_SYMBOL_NOT_FOUND) instead of returning an empty market list. '
        + 'Read-only: this tool cannot place, cancel or modify anything.'
        + FRESHNESS_NOTE,
      parameters: {
        eventId: { type: 'string', required: true as const, description: 'Polymarket event id (digits, e.g. 606422) or its exact slug (e.g. fed-decision-in-october-20260617190323537).' },
      },
      output: detailOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const result = await service.eventDetail({ eventId: String(args.eventId ?? '') })
        return { observedAt: result.observedAt, source: result.source, stale: result.stale, event: jsonPayload(result.event) }
      },
    }),
  ]
}

function readLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}
