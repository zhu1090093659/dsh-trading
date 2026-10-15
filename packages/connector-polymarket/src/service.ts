/**
 * 预测市场取数服务（host 平面 provide `tradingPredictionFeed`）。
 *
 * 与 @dshtrading/connector-jin10 的 macro-service.ts 同款形态与理由：GUI 面板走
 * `/dshtrading/api/prediction/*` 桥（node 半），桥只能经 cordis 服务拿到取数实现；
 * 面板面与将来的 agent 工具面共用同一个 PolymarketService 实例，避免两份取数
 * 逻辑漂移（禁止两套判据）。服务缺席（连接器未装/未启用）时桥报
 * TRADING_NOT_IMPLEMENTED，绝不把「没装数据源」伪装成「没有数据」。
 *
 * 形态选普通对象 + `ctx.reflect.provide`，理由见 macro-service.ts 头注。
 */
import type { PredictionFeed, PredictionFeedService, PredictionMeeting } from '@dshtrading/api'
import { FOMC_SERIES_ID, discoverFomcMeetings } from './discovery.js'
import { PolymarketError } from './errors.js'
import { type EventDetail, type EventSummary, parseEventDetail, searchEventsInPage } from './events.js'
import { type GammaClient, type GammaResponse, isCdnCached } from './gamma.js'
import type { SnapshotStore } from './snapshot.js'

export const TRADING_PREDICTION_FEED_KEY = 'tradingPredictionFeed'

/** 单次取数的候选上限（上游 limit 上限 100，证据 Q1.4；`limit=500` 与 `limit=100` 同结果）。 */
export const PREDICTION_EVENTS_LIMIT = 100

/** 关键词检索的返回条数默认/上限（取数页恒为 {@link PREDICTION_EVENTS_LIMIT}）。 */
export const PREDICTION_SEARCH_DEFAULT_LIMIT = 20
export const PREDICTION_SEARCH_MAX_LIMIT = 50

/** 工具面 `source` 字段的唯一取值：数据来自哪个读取面（公开只读，无密钥）。 */
export const POLYMARKET_SOURCE = 'gamma-api.polymarket.com /events (public read-only upstream)'

/**
 * 工具面出参的时间/出处/新鲜度三件套。
 *
 * `stale` 的判据只有一个（见 {@link isCdnCached}）：本次响应是否由共享 CDN 直接命中。
 * 它**不是**「数据旧了」的推测，而是「拿到的是副本」的实证。
 */
export interface Freshness {
  /** 本进程的取数时刻（ISO 8601 UTC；上游无响应级时间戳，数据时间戳只能由取数侧记录）。 */
  readonly observedAt: string
  readonly source: string
  readonly stale: boolean
}

/** FOMC 工具面结果（可按 meetingId 收窄）。 */
export interface PredictionFomcResult extends Freshness {
  readonly meetings: readonly PredictionMeeting[]
}

/** 关键词检索结果：`filtering` 恒为本地过滤标记（上游无检索参数，见 events.ts 头注）。 */
export interface PredictionEventSearchResult extends Freshness {
  readonly filtering: 'local-page-filter'
  /** 本次实际请求的取数页大小（恒为 {@link PREDICTION_EVENTS_LIMIT}）。 */
  readonly pageLimit: number
  /** 本次扫描的上游事件数。 */
  readonly scanned: number
  /** 关键词命中数（截断到返回条数**之前**）。 */
  readonly matched: number
  readonly events: readonly EventSummary[]
}

/** 单事件详情结果。 */
export interface PredictionEventDetailResult extends Freshness {
  readonly event: EventDetail
}

export interface PolymarketServiceOptions {
  readonly gamma: GammaClient
  /** 快照存储；缺省 = 不做 Δ 标注（服务仍可用）。 */
  readonly snapshots?: SnapshotStore | undefined
  /** 时钟注入（测试固定 fetchedAt 用；缺省 Date.now）。 */
  readonly now?: (() => number) | undefined
}

/**
 * 取数实现：**一次 GET 拿全量**（证据 Q2.3 的 v1 裁决理由）。
 *
 * `cacheBust` 的用途（证据 Q3.4）：`/events` 有 `max-age=300` CDN 缓存，同一请求
 * 5 分钟内只会拿到同一份副本。默认**不加**（面板轮询间隔离不开 5 分钟时缓存是
 * 有益的去重）；需要真实时值时可显式打开。
 */
export class PolymarketService {
  private readonly gamma: GammaClient
  private readonly snapshots: SnapshotStore | undefined
  private readonly now: () => number

  constructor(options: PolymarketServiceOptions) {
    this.gamma = options.gamma
    this.snapshots = options.snapshots
    this.now = options.now ?? Date.now
  }

  /**
   * `@dshtrading/api` 形状的取数面（桥/面板消费）。只是把 {@link fomcMeetings} 的结果
   * 投影成 `PredictionFeed`——`fetchedAt` 与工具面的 `observedAt` 是同一个取数时刻，
   * 两个字段名各归各自的契约，不是两次取数。
   */
  async listFomcMeetings(options: { cacheBust?: boolean | undefined } = {}): Promise<PredictionFeed> {
    const snapshot = await this.fomcMeetings(options)
    return { fetchedAt: snapshot.observedAt, meetings: snapshot.meetings }
  }

  /**
   * FOMC 决议路径全量会议（含已结算；按 endDate 升序）——**取数逻辑的唯一实现**。
   *
   * **失败必须响亮**：传输失败、HTTP 403（Cloudflare 1010 的 text/plain 体）、
   * 非 JSON 体、非数组体一律抛结构化错误——绝不返回 `{meetings: []}`。空数组
   * 只代表「上游确实返回了空集合」这一种真实语义。
   *
   * `meetingId` 命中 event id 或 slug（精确匹配）；给了但一场都没匹配到时抛
   * TRADING_SYMBOL_NOT_FOUND——「上游说查不到」与「上游故障」是两件事，消费方不该把
   * 前者当基础设施抖动去重试。
   */
  async fomcMeetings(options: { cacheBust?: boolean | undefined; meetingId?: string | undefined } = {}): Promise<PredictionFomcResult> {
    const query: Record<string, string> = { series_id: FOMC_SERIES_ID, limit: String(PREDICTION_EVENTS_LIMIT), closed: 'false' }
    if (options.cacheBust === true) query._cb = String(this.now())
    const response = await this.gamma.get('/events', query)
    const { meetings } = discoverFomcMeetings(response.body)
    const observedAt = new Date(this.now()).toISOString()
    // 先标注全量再收窄：Δ 的基线要连续——只问一场时，其余会议已记下的基线不该被丢掉。
    const annotated = await this.annotate(meetings, observedAt)
    const wanted = options.meetingId?.trim()
    if (wanted === undefined || wanted === '') return this.withFreshness(response, observedAt, { meetings: annotated })
    const selected = annotated.filter((meeting) => meeting.id === wanted || meeting.slug === wanted)
    if (selected.length === 0) {
      throw new PolymarketError(
        'TRADING_SYMBOL_NOT_FOUND',
        `polymarket gamma /events?series_id=${FOMC_SERIES_ID}: no FOMC meeting matches ${JSON.stringify(wanted)} (accepted: event id or slug)`,
      )
    }
    return this.withFreshness(response, observedAt, { meetings: selected })
  }

  /**
   * 关键词检索（中文或英文，大小写不敏感子串，命中事件标题或 slug——**不搜档位标签**，
   * 理由见 events.ts 的 `matchesKeyword`）。
   *
   * 上游 `/events` **没有关键词参数**（实测 `q=`/`title=` 与无参数逐条同结果），所以
   * 这里是单次拉「开盘中、24h 成交额降序」的一页再本地过滤，输出带
   * `filtering: 'local-page-filter'` 与 `scanned`，让消费方一眼看出这是「一页 ∩ 关键词」，
   * 不是上游检索。
   *
   * 空关键词**先抛错、零请求**：空串会匹配一切，静默回「最热 N 条」冒充检索命中就是编造。
   */
  async searchEvents(options: { keyword: string; limit?: number | undefined }): Promise<PredictionEventSearchResult> {
    const keyword = options.keyword.trim()
    if (keyword === '') throw new Error('polymarket /events: keyword must be a non-empty string')
    const limit = options.limit ?? PREDICTION_SEARCH_DEFAULT_LIMIT
    const response = await this.gamma.get('/events', {
      closed: 'false',
      order: 'volume24hr',
      ascending: 'false',
      limit: String(PREDICTION_EVENTS_LIMIT),
    })
    const observedAt = new Date(this.now()).toISOString()
    const page = searchEventsInPage(response.body, keyword, limit)
    return this.withFreshness(response, observedAt, {
      filtering: 'local-page-filter' as const,
      pageLimit: PREDICTION_EVENTS_LIMIT,
      ...page,
    })
  }

  /**
   * 单事件详情（eventId 接受 event id 或 slug，精确匹配，**单次请求**）。
   *
   * 上游 200 空集 = 没有这个事件 → TRADING_SYMBOL_NOT_FOUND；传输/准入/契约失败照旧由
   * 传输层结构化抛出，两者不互相冒充。
   */
  async eventDetail(options: { eventId: string }): Promise<PredictionEventDetailResult> {
    const eventId = options.eventId.trim()
    if (eventId === '') throw new Error('polymarket /events: eventId must be a non-empty event id or slug')
    const response = await this.gamma.get('/events', /^\d+$/.test(eventId) ? { id: eventId } : { slug: eventId })
    const observedAt = new Date(this.now()).toISOString()
    const event = parseEventDetail(response.body)
    if (event === undefined) {
      throw new PolymarketError(
        'TRADING_SYMBOL_NOT_FOUND',
        `polymarket gamma /events: no event matches ${JSON.stringify(eventId)} (HTTP ${response.status} with an empty result set)`,
      )
    }
    return this.withFreshness(response, observedAt, { event })
  }

  private withFreshness<T extends object>(response: GammaResponse, observedAt: string, payload: T): T & Freshness {
    return { observedAt, source: POLYMARKET_SOURCE, stale: isCdnCached(response), ...payload }
  }

  /**
   * Δ 标注：**快照失败不阻断取数**。
   *
   * 为什么与上游失败区别对待：上游失败时我们没有任何可信数据，必须响亮抛错；
   * 快照失败时概率本身依然完整正确，缺的只是「与上次差多少」这一项增益标注。
   * 此时若整块失败，会把一次磁盘/权限问题放大成整个面板黑屏。
   *
   * 但降级必须**可见**：log 到 stderr，并且返回的档位**不带** `changeSincePrevious`
   * （缺省 = 不知道），绝不填 0——0 表示「确知没变」，那是编造。
   */
  private async annotate(meetings: readonly PredictionMeeting[], observedAt: string): Promise<readonly PredictionMeeting[]> {
    if (this.snapshots === undefined) return meetings
    try {
      return await this.snapshots.annotate(meetings, observedAt)
    } catch (error) {
      console.error('[dsh-trading/connector-polymarket] snapshot annotation unavailable, continuing without Δ:', error)
      return meetings
    }
  }
}

/** host 平面服务面：桥与工具面共用的最小接口（@dshtrading/api 的 PredictionFeedService）。 */
export function createPolymarketPredictionFeed(service: PolymarketService): PredictionFeedService {
  return {
    /** 当前 FOMC 决议路径全部会议（含已结算）。 */
    async listFomcMeetings(): Promise<PredictionFeed> {
      return service.listFomcMeetings()
    },
  }
}
