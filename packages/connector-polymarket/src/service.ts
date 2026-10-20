/**
 * 预测市场取数服务（host 平面 provide `tradingPredictionFeed`）。
 *
 * 与 @dshtrading/connector-jin10 的 macro-service.ts 同款形态与理由：GUI 面板走
 * `/dshtrading/api/prediction/*` 桥（node 半），桥只能经 cordis 服务拿到取数实现；
 * 面板面与将来的 agent 工具面共用同一个 PolymarketService 实例，避免两份取数
 * 逻辑漂移（禁止两套判据）。服务缺席（连接器未装/未启用）时桥报
 * TRADING_NOT_IMPLEMENTED，绝不把「没装数据源」伪装成「没有数据」。
 *
 * 两个取数面共用本服务：会议面（gamma `/events`，一次请求拿全量档位）与历史面
 * （CLOB `/prices-history`，按档位 token 扇出）。历史面只补齐「面板打开之前」的读数，
 * 不改会议面任何概率判据（`p` 与 gamma `outcomePrices[0]` 实测同口径，证据 Q2.1）。
 *
 * 形态选普通对象 + `ctx.reflect.provide`，理由见 macro-service.ts 头注。
 */
import type {
  PredictionFeed,
  PredictionFeedService,
  PredictionMeeting,
  PredictionPriceHistory,
  PredictionPriceHistoryRequest,
  PredictionPriceSeries,
} from '@dshtrading/api'
import { DEFAULT_PRICE_HISTORY_FIDELITY_MINUTES, assertPriceHistoryRange } from './clob.js'
import type { ClobClient } from './clob.js'
import { FOMC_SERIES_ID, discoverFomcMeetings } from './discovery.js'
import { PolymarketError } from './errors.js'
import type { GammaClient } from './gamma.js'
import type { SnapshotStore } from './snapshot.js'

export const TRADING_PREDICTION_FEED_KEY = 'tradingPredictionFeed'

/** 单次取数的候选上限（上游 limit 上限 100，证据 Q1.4）。 */
export const PREDICTION_EVENTS_LIMIT = 100

/**
 * 会议发现结果的缓存窗口（ms）——**短 TTL，只挡同一刷新周期内的重复发现**。
 *
 * 历史面必须先按 `meetingId` 找到会议才能拿到各档 token；面板每换一个事件、每重绘
 * 一次都会要历史，不缓存就是「面板每个事件打一次 gamma」（`/events` 还有
 * `max-age=300` 的 CDN 缓存，重复打只是白等一份同一副本）。60 秒的依据：会议集合是
 * 以天为单位变化的（新会议按周出现、结算按会议日翻转），60s 足够短到不掩盖真实变化，
 * 又足够长到覆盖一次面板交互的全部事件请求。
 *
 * **失败不入缓存**：网络抖动不会被记成「没有这场会议」，下一次重试照常打上游。
 */
export const MEETING_LOOKUP_TTL_MS = 60_000

export interface PolymarketServiceOptions {
  readonly gamma: GammaClient
  /** CLOB 历史传输层（`/prices-history`）。 */
  readonly clob: ClobClient
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
  private readonly clob: ClobClient
  private readonly snapshots: SnapshotStore | undefined
  private readonly now: () => number
  private meetingLookup: { readonly atMs: number; readonly meetings: readonly PredictionMeeting[] } | undefined

  constructor(options: PolymarketServiceOptions) {
    this.gamma = options.gamma
    this.clob = options.clob
    this.snapshots = options.snapshots
    this.now = options.now ?? Date.now
  }

  /**
   * FOMC 决议路径全量会议（含已结算；按 endDate 升序）。
   *
   * **失败必须响亮**：传输失败、HTTP 403（Cloudflare 1010 的 text/plain 体）、
   * 非 JSON 体、非数组体一律抛结构化错误——绝不返回 `{meetings: []}`。空数组
   * 只代表「上游确实返回了空集合」这一种真实语义。
   */
  async listFomcMeetings(options: { cacheBust?: boolean | undefined } = {}): Promise<PredictionFeed> {
    const meetings = await this.fetchMeetings(options.cacheBust === true)
    const fetchedAt = new Date(this.now()).toISOString()
    return { fetchedAt, meetings: await this.annotate(meetings, fetchedAt) }
  }

  /**
   * 单场会议在请求窗口内的逐档历史读数（面板「事件对照」的回填来源）。
   *
   * 三段语义（每一段都对应一条验收要求，改这里前先读它们）：
   *
   * 1. **空 ≠ 失败**。上游 token 不存在时回 `200 {"history":[]}`（Q5.2），与本窗口确实
   *    没有读数**无法在响应上区分**。所以空 history 只产生 `points: []`、不抛错——
   *    但也只是「这一档在这个窗口没有可用读数」，不等于「概率为 0」「没有变动」：
   *    面板照实留白，不许画一条 0 的线。
   * 2. **任一档失败必须响亮抛出**（`Promise.all` 全否）。少一档就是**把失败画成没有
   *    变动**——用户看到的是一条平的线，而真实情况是「这一档我们没取到」。宁可整块
   *    报错让面板显示失败，也不给一份看起来完整、实则缺档的图。
   * 3. **拿不到 token 的档位不扇出**：`clobTokenId` 缺省 = 上游没给定位键（或解析失败），
   *    没有 token 就没有任何可请求的对象，**不猜**、也不给这一档造一条空序列；它就
   *    不出现在 `series` 里（调用方按 bucketKey 找不到 = 这一档没有历史可对照）。
   *
   * 请求参数在**打 gamma 之前**校验（{@link assertPriceHistoryRange}：`fromMs < toMs`、
   * 窗口 ≤ 336h、fidelity > 0）：桥侧已有同值闸门，这里是纵深防御——让非法请求
   * 一次上游请求都不产生，而不是拿一个必然失败的窗口去打两次网络。
   * `fidelityMinutes` 缺省 5 分钟（面板口径，依据见 clob.ts 的同名常量）。
   */
  async listPriceHistory(request: PredictionPriceHistoryRequest): Promise<PredictionPriceHistory> {
    const fidelityMinutes = request.fidelityMinutes ?? DEFAULT_PRICE_HISTORY_FIDELITY_MINUTES
    assertPriceHistoryRange(request.fromMs, request.toMs, fidelityMinutes)

    const meetings = await this.meetingsForLookup()
    const meeting = meetings.find((entry) => entry.id === request.meetingId)
    if (meeting === undefined) {
      // 上游答了（gamma 请求成功）但没有这场会议 —— 与 TRADING_SYMBOL_NOT_FOUND 的
      // 「上游说查不到」同义，消费方不该当基础设施抖动去重试；不用 TRADING_UNSUPPORTED
      // （那是零请求的本地形态判定，我们确实打了一次 gamma）。
      throw new PolymarketError(
        'TRADING_SYMBOL_NOT_FOUND',
        `polymarket prediction price history: meeting ${request.meetingId} is not an FOMC decision meeting (looked up ${meetings.length} open meetings)`,
      )
    }

    const targets: { readonly key: string; readonly token: string }[] = []
    for (const bucket of meeting.buckets) {
      if (bucket.clobTokenId !== undefined) targets.push({ key: bucket.key, token: bucket.clobTokenId })
    }

    // Promise.all：一档一次请求、并发发出；任一档拒绝 → 整块拒绝（见上面第 2 段）。
    // 拒绝时把档位键带上：只说「有一档失败」用户无从判断是哪一档，等于半个错误。
    const series: PredictionPriceSeries[] = await Promise.all(
      targets.map(async (target) => {
        try {
          const history = await this.clob.priceHistory({
            token: target.token,
            fromMs: request.fromMs,
            toMs: request.toMs,
            fidelityMinutes,
          })
          return { bucketKey: target.key, points: history.points }
        } catch (cause) {
          throw bucketFailure(target.key, cause)
        }
      }),
    )

    return {
      fetchedAt: new Date(this.now()).toISOString(),
      meetingId: meeting.id,
      fromMs: request.fromMs,
      toMs: request.toMs,
      fidelityMinutes,
      series,
    }
  }

  /** 一次 gamma `/events` + 发现规则（不做 Δ 标注：历史面不需要快照）。 */
  private async fetchMeetings(cacheBust: boolean): Promise<readonly PredictionMeeting[]> {
    const query: Record<string, string> = { series_id: FOMC_SERIES_ID, limit: String(PREDICTION_EVENTS_LIMIT), closed: 'false' }
    if (cacheBust) query._cb = String(this.now())
    const response = await this.gamma.get('/events', query)
    return discoverFomcMeetings(response.body).meetings
  }

  /** 历史面的会议定位：短 TTL 缓存（见 {@link MEETING_LOOKUP_TTL_MS}；失败不缓存）。 */
  private async meetingsForLookup(): Promise<readonly PredictionMeeting[]> {
    const atMs = this.now()
    const cached = this.meetingLookup
    if (cached !== undefined && Math.abs(atMs - cached.atMs) < MEETING_LOOKUP_TTL_MS) return cached.meetings
    const meetings = await this.fetchMeetings(false)
    this.meetingLookup = { atMs, meetings }
    return meetings
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

/**
 * 单档失败 → 带档位键的结构化错误（保留原 code：传输失败仍是 TRADING_NETWORK，
 * 上游拒答仍是 TRADING_UPSTREAM_ERROR，消费方的重试判断不被这层包装改变）。
 */
function bucketFailure(bucketKey: string, cause: unknown): PolymarketError {
  const code = cause instanceof PolymarketError ? cause.code : 'TRADING_UNKNOWN'
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new PolymarketError(
    code,
    `polymarket prediction price history: bucket ${bucketKey} failed — ${reason}`,
    cause,
  )
}

/** host 平面服务面：桥与工具面共用的最小接口（@dshtrading/api 的 PredictionFeedService）。 */
export function createPolymarketPredictionFeed(service: PolymarketService): PredictionFeedService {
  return {
    /** 当前 FOMC 决议路径全部会议（含已结算）。 */
    async listFomcMeetings(): Promise<PredictionFeed> {
      return service.listFomcMeetings()
    },
    /** 单场会议的逐档历史读数（回填面板打开之前的时点）。 */
    async listPriceHistory(request: PredictionPriceHistoryRequest): Promise<PredictionPriceHistory> {
      return service.listPriceHistory(request)
    },
  }
}
