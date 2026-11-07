/**
 * Polymarket 预测市场面板（右缘会话列容器的功能页签 6 号，2026-10-11）。
 *
 * 与定时任务/资产/快讯/宏观/文件同款模式：竖条第 6 个按钮激活时原位覆盖对话列
 * （五处互斥联动见 SessionRail，shell-pad.css 规则 16），状态由 SessionRail 写
 * body[data-dshtrading-prediction-open]。定位与宽度吃 frame 轨道变量
 * （polymarket-panel.module.css）。
 *
 * 数据面 = host 面 tradingPredictionFeed 服务（桥 /dshtrading/api/prediction/fomc，
 * P1 数据面卡已交付）。本面板**只读**：不提供任何下单/交易入口。
 *
 * 三处 owner 裁决（2026-10-11）：
 * - 显示概率取 bestAsk（与 Polymarket 网页逐值一致）；Δ 沿用宿主快照的 mid 基准，
 *   基准差异在标题行显式标注，不隐式换算（口径明细见 prediction-view.ts 头注）。
 * - 质量阈值：深度 < 100k USD 记「深度不足」、价差 > 0.02 记「价差过宽」。
 * - 事件对照一律取 **mid**：会话内按轮询节拍留 (时间, 各档 mid) 采样，另外按事件
 *   开窗回填上游历史（前后各 24h、5 分钟档），两条时间轴合并后读「公布 → 概率
 *   跳变」。取不到时区分「上游历史不覆盖」与「采样不足」，绝不填 0；
 *   对照口径与显示口径在标题下各自标注。
 *
 * 三个源（预测市场 / 宏观日历 / 历史回填）**各自记账**：任一失败只影响自己那块，
 * 绝不把失败画成「没有数据」。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchMacroCalendar,
  fetchPredictionFomc,
  fetchPredictionHistory,
  type ClientMacroCalendarEntry,
  type ClientPredictionHistory,
  type ClientPredictionHistoryRequest,
  type ClientPredictionHistoryResult,
  type ClientPredictionResult,
} from './api.ts'
import type { MarketLocaleKey } from './contract.ts'
import {
  appendSample,
  candidateEventsOf,
  eventComparisonOf,
  formatDeltaPp,
  formatProbability,
  HISTORY_FIDELITY_MINUTES,
  historyWindowOf,
  inflationEventsOf,
  MAX_SAMPLES,
  meetingViewOf,
  mergeSamples,
  samplesFromHistory,
  visibleMeetingsOf,
  VISIBLE_MEETINGS,
  type EventComparison,
  type InflationEvent,
  type MeetingView,
  type ProbabilitySample,
} from './prediction-view.ts'
import css from './polymarket-panel.module.css'

/** 轮询周期：概率是分钟级信息的连续量，1 分钟足够新且不侵蚀上游配额。 */
const POLL_MS = 60_000
/** 日历条目上限（与 MacroPanel 同值，整周实测已到 254 条）。 */
const CALENDAR_LIMIT = 400
/** 事件对照行上限：近 30 天内已公布的美国 CPI/PPI，按时间降序取前几条。 */
const EVENT_ROWS = 6

type FeedState = 'loading' | 'ready' | 'error'

/** 单个事件的历史回填结果（按 event.at 缓存：成功与失败都算「已取过」）。 */
type HistoryEntry =
  | { readonly status: 'ok'; readonly history: ClientPredictionHistory }
  | { readonly status: 'error'; readonly code: string }

/** 事件行状态：四态 + 取数中的瞬态（pending 不落 data 属性，避免伪造结论）。 */
type EventRowState = 'pending' | 'comparable' | 'insufficient' | 'uncovered' | 'history-error'

interface EventRow {
  readonly state: EventRowState
  readonly comparison?: Extract<EventComparison, { readonly state: 'comparable' }>
  readonly code?: string
}

/** 可注入的数据缝（测试用真实函数替身，不引入 mock 工具）。 */
export interface PolymarketPanelDeps {
  fetchPrediction?: ((signal?: AbortSignal) => Promise<ClientPredictionResult>) | undefined
  fetchCalendar?: ((limit: number, signal?: AbortSignal) => Promise<ClientMacroCalendarEntry[] | null>) | undefined
  /** 上游历史回填（缺省桥 /prediction/history）；按事件各取一次。 */
  fetchHistory?: ((request: ClientPredictionHistoryRequest, signal?: AbortSignal) => Promise<ClientPredictionHistoryResult>) | undefined
  /** 时钟（采样时间轴与回填窗口用；缺省 Date.now）。 */
  now?: (() => number) | undefined
}

export type PolymarketPanelTranslate = (key: MarketLocaleKey) => string

export interface PolymarketPanelProps {
  t: PolymarketPanelTranslate
  /** 关闭面板（竖条按钮/头部 ×）。 */
  onClose(): void
  deps?: PolymarketPanelDeps | undefined
}

/** 档位方向（上游标签原义展示，方向只用于分组标题）。 */
function directionOf(changeBps: number | undefined): 'cut' | 'hold' | 'hike' | 'unknown' {
  if (changeBps === undefined) return 'unknown'
  if (changeBps < 0) return 'cut'
  if (changeBps > 0) return 'hike'
  return 'hold'
}

/** 方向 → 词典键。 */
function directionKeyOf(changeBps: number | undefined): MarketLocaleKey {
  const direction = directionOf(changeBps)
  if (direction === 'cut') return 'prediction.dir.cut'
  if (direction === 'hike') return 'prediction.dir.hike'
  if (direction === 'hold') return 'prediction.dir.hold'
  return 'prediction.dir.unknown'
}

/** 本地时刻短文本（MM-DD HH:mm）。 */
function shortTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function PolymarketPanel({ t, onClose, deps }: PolymarketPanelProps) {
  const fetchPrediction = deps?.fetchPrediction ?? fetchPredictionFomc
  const fetchCalendar = deps?.fetchCalendar ?? fetchMacroCalendar
  const fetchHistory = deps?.fetchHistory ?? fetchPredictionHistory
  const now = deps?.now ?? Date.now

  const [meetings, setMeetings] = useState<readonly MeetingView[]>([])
  const [predictionState, setPredictionState] = useState<FeedState>('loading')
  const [predictionCode, setPredictionCode] = useState<string>('')
  const [fetchedAt, setFetchedAt] = useState<string>('')
  // 宏观日历独立记账（与 MacroPanel 同源：金十宏观日历）。
  const [events, setEvents] = useState<readonly InflationEvent[]>([])
  const [calendarState, setCalendarState] = useState<FeedState>('loading')
  // 会话内采样：面板打开期间累积，「事件 → 概率变化」靠它与历史回填合并成全时间轴。
  const [samples, setSamples] = useState<readonly ProbabilitySample[]>([])
  // 采样游标用 ref：轮询闭包每次读最新值，不进依赖数组（避免重建定时器）。
  const samplesRef = useRef<readonly ProbabilitySample[]>([])
  // 历史回填结果：键 = 事件时刻 event.at。ref 是「已取过」的权威账本（含失败），
  // state 只负责触发重绘——所以 60s 轮询不会重复拉同一个事件的历史。
  const historyRef = useRef<Readonly<Record<number, HistoryEntry>>>({})
  const historyInflightRef = useRef<Set<number>>(new Set())
  const [history, setHistory] = useState<Readonly<Record<number, HistoryEntry>>>({})

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      // 三个源各自 await 各自记账：一个失败不影响另一个的展示。
      const [prediction, calendar] = await Promise.all([
        fetchPrediction().catch((): ClientPredictionResult => ({ status: 'error', code: 'TRADING_UNEXPECTED', message: 'fetcher threw' })),
        fetchCalendar(CALENDAR_LIMIT).catch(() => null),
      ])
      if (cancelled) return

      if (prediction.status === 'error') {
        setPredictionState('error')
        setPredictionCode(prediction.code)
      } else {
        const views = prediction.meetings.map(meetingViewOf)
        setMeetings(views)
        setFetchedAt(prediction.fetchedAt)
        setPredictionState('ready')
        // 采样记前几场会议（与展示的会议组同集）的各档 **mid**——事件对照与上游历史
        // 同源（见 prediction-view.ts 头注）；显示值仍取 bestAsk，两者不混算。
        for (const meeting of visibleMeetingsOf(prediction.meetings)) {
          const values: Record<string, number> = {}
          for (const bucket of meetingViewOf(meeting).buckets) values[`${meeting.id}:${bucket.key}`] = bucket.midProbability
          samplesRef.current = appendSample(samplesRef.current, { at: now(), values })
        }
        setSamples(samplesRef.current)
      }

      if (calendar === null) {
        setCalendarState('error')
      } else {
        setEvents(inflationEventsOf(calendar))
        setCalendarState('ready')
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [fetchPrediction, fetchCalendar, now])

  // 会议组：下一次会议 + 后续至多 VISIBLE_MEETINGS-1 次（spike 判据里同批可用的
  // 后续会议；全量返回里更远的会议只作数据，不上屏）。
  const shown = meetings.filter((meeting) => !meeting.closed).slice(0, VISIBLE_MEETINGS)
  // 事件对照以第一场（最近的）会议的档位为观察对象；采样键含会议 id。
  const next = shown.length === 0 ? undefined : shown[0]
  const keys = next === undefined ? [] : next.buckets.map((bucket) => `${next.id}:${bucket.key}`)
  // 事件列表 = 已公布且在上游 30 天保留期内的美国 CPI/PPI，按时间降序取前 EVENT_ROWS 条。
  const candidates = useMemo(() => candidateEventsOf(events, now()).slice(0, EVENT_ROWS), [events, now])
  const observerId = next === undefined ? undefined : next.id

  // 历史回填：每个候选事件**只发一次**（键 event.at，成功/失败都记账），
  // meetingId = 当前第一场未结算会议。失败不影响档位表、会话采样与日历块。
  // 观察会议在面板生命期内变化（那一场结算了）时不重拉：旧缓存的键带着旧会议 id，
  // 对不上新观察会议的档位键，该行就如实退化成「采样不足」，绝不混用两场会议的读数。
  useEffect(() => {
    if (observerId === undefined) return
    for (const event of candidates) {
      if (historyRef.current[event.at] !== undefined) continue
      if (historyInflightRef.current.has(event.at)) continue
      historyInflightRef.current.add(event.at)
      const window = historyWindowOf(event.at, now())
      // 结果与组件生命周期无关地写进账本：被取消的那一轮不能把已取回的结果丢掉，
      // 否则行会永远停在 pending（ref 与 state 必须同时前进）。
      const record = (entry: HistoryEntry): void => {
        historyRef.current = { ...historyRef.current, [event.at]: entry }
        setHistory(historyRef.current)
      }
      void fetchHistory({ meetingId: observerId, fromMs: window.fromMs, toMs: window.toMs, fidelityMinutes: HISTORY_FIDELITY_MINUTES })
        .then((result) => {
          record(result.status === 'ok' ? { status: 'ok', history: result.history } : { status: 'error', code: result.code })
        })
        .catch(() => { record({ status: 'error', code: 'TRADING_UNEXPECTED' }) })
        .finally(() => { historyInflightRef.current.delete(event.at) })
    }
  }, [candidates, observerId, fetchHistory, now])

  /**
   * 单个事件行的判据（四态 + pending）。判定顺序：能对照就先给读数（两条时间轴
   * 合并后任一侧有数就能算）；算不出来再解释原因——回填为空 = 上游历史不覆盖该
   * 时点，回填有覆盖但单侧缺失 = 采样不足。两种事实不合并，也绝不填 0。
   */
  const rowOf = (event: InflationEvent): EventRow => {
    // 没有未结算会议 = 没有观察对象，回填也无意义（不假装在采样）。
    if (next === undefined) return { state: 'insufficient' }
    const entry = history[event.at]
    if (entry === undefined) return { state: 'pending' }
    // 取数失败先于「回填为空」判定：桥挂了不等于上游没覆盖（uncovered），两者不合并。
    if (entry.status === 'error') return { state: 'history-error', code: entry.code }
    const historySamples = samplesFromHistory(entry.history)
    // 裁尾上限放到「历史窗口全量 + 会话环上限」：该上限恒 ≥ 合并后长度（会话采样已按
    // MAX_SAMPLES 封顶，历史点数由窗口固定），因此一条都不裁。若用默认 MAX_SAMPLES，
    // 48h/5min 的 576 点只剩最新 240 点（约后 20h），事件前那一段必被挤掉 → 退化。
    const comparison = eventComparisonOf(
      mergeSamples(historySamples, samples, historySamples.length + MAX_SAMPLES),
      event.at,
      keys,
    )
    if (comparison.state === 'comparable') return { state: 'comparable', comparison }
    return historySamples.length === 0 ? { state: 'uncovered' } : { state: 'insufficient' }
  }

  return (
    <div className={css.panel} data-dshtrading-polymarket-panel="" role="panel" aria-label={t('stage.prediction')}>
      <header className={css.head}>
        <strong className={css.title}>{t('stage.prediction')}</strong>
        <span className={css.spacer} />
        <button type="button" className={css.closeBtn} aria-label={t('flash.close')} title={t('flash.close')} onClick={onClose}>×</button>
      </header>
      <div className={css.body}>
        {predictionState === 'error' ? (
          <p className={css.error} data-dshtrading-prediction-error={predictionCode}>
            {predictionCode === 'TRADING_NOT_IMPLEMENTED' ? t('prediction.errorNotInstalled') : t('prediction.error')}
          </p>
        ) : null}
        {predictionState === 'loading' ? <p className={css.empty}>{t('prediction.loading')}</p> : null}
        {predictionState === 'ready' && next === undefined ? (
          <p className={css.empty}>{t('prediction.noMeeting')}</p>
        ) : null}
        {predictionState === 'ready' ? shown.map((meeting, index) => (
          <div className={css.meeting} key={meeting.id} data-dshtrading-prediction-meeting={meeting.id}>
            <div className={css.meetingTitle}>{meeting.title}</div>
            <div className={css.meetingMeta}>
              {meeting.meetingWindow !== undefined ? <span>{meeting.meetingWindow}</span> : null}
              <span>{t('prediction.ends')} {shortTime(Date.parse(meeting.endDate))}</span>
              {/* 只对最近一场标口径基准：后续会议同一组口径，重复标注是噪音。 */}
              {index === 0 ? <span>{t('prediction.basisAsk')}</span> : null}
            </div>

            {/* 健康检查：概率和越界可见提示，绝不静默。 */}
            {meeting.sumHealth === 'off-band' ? (
              <p className={css.warn} data-dshtrading-prediction-sum={meeting.probabilitySum.toFixed(3)}>
                {t('prediction.sumOffBand')} {meeting.probabilitySum.toFixed(3)}
              </p>
            ) : null}
            {meeting.degraded.length > 0 ? (
              <p className={css.warn} data-dshtrading-prediction-degraded={meeting.degraded.join(',')}>
                {t('prediction.degraded')} {meeting.degraded.join(', ')}
              </p>
            ) : null}

            <div className={css.buckets}>
              {meeting.buckets.map((bucket) => {
                const delta = formatDeltaPp(bucket.delta)
                return (
                  <div className={css.bucket} key={bucket.key} data-dshtrading-bucket={`${meeting.id}:${bucket.key}`}>
                    <div className={css.bucketTop}>
                      <span className={css.bucketLabel}>{bucket.label}</span>
                      <span className={css.bucketProb}>{formatProbability(bucket.probability)}</span>
                      {/* 快照不足 → delta 缺省 → 整块不渲染（不是显示 0）。 */}
                      {delta !== undefined ? (
                        <span className={css.delta} data-sign={bucket.delta === undefined || bucket.delta === 0 ? 'flat' : bucket.delta > 0 ? 'up' : 'down'}>{delta}</span>
                      ) : null}
                    </div>
                    <div className={css.bar}>
                      <span className={css.barFill} style={{ width: `${Math.max(0, Math.min(1, bucket.probability)) * 100}%` }} />
                    </div>
                    <div className={css.bucketMeta}>
                      <span className={css.bucketDir}>{t(directionKeyOf(bucket.changeBps))}</span>
                      {bucket.marks.includes('thin-depth') ? (
                        <span className={css.mark} data-mark="thin-depth">{t('prediction.thinDepth')}</span>
                      ) : null}
                      {bucket.marks.includes('wide-spread') ? (
                        <span className={css.mark} data-mark="wide-spread">{t('prediction.wideSpread')}</span>
                      ) : null}
                      {bucket.closed ? <span className={css.mark}>{t('prediction.closed')}</span> : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )) : null}

        {/* 事件对照：宏观日历与历史回填各自记账——这里失败只影响这一块。 */}
        <div className={css.events}>
          <div className={css.sectionTitle}>{t('prediction.eventsTitle')}</div>
          {/* 口径标注：对照取 mid（历史段与会话段唯一同源口径）、显示取 bestAsk。 */}
          <p className={css.basis} data-dshtrading-event-basis="">{t('prediction.basisComparison')}</p>
          {calendarState === 'error' ? <p className={css.error}>{t('prediction.calendarError')}</p> : null}
          {calendarState === 'loading' ? <p className={css.empty}>{t('macro.loading')}</p> : null}
          {calendarState === 'ready' && candidates.length === 0 ? (
            <p className={css.empty}>{t('prediction.noComparable')}</p>
          ) : null}
          {calendarState === 'ready' ? candidates.map((event) => {
            const row = rowOf(event)
            return (
              <div
                className={css.eventRow}
                key={`${event.at}-${event.title}`}
                data-dshtrading-event={event.at}
                data-dshtrading-event-state={row.state === 'pending' ? undefined : row.state}
              >
                <span className={css.eventTime}>{shortTime(event.at)}</span>
                <span className={css.eventTitle}>{event.title}</span>
                {row.state === 'comparable' && row.comparison !== undefined ? (
                  <span className={css.eventDelta} data-dshtrading-event-delta={row.comparison.key}>
                    {formatProbability(row.comparison.movement.before)}
                    {' → '}
                    {formatProbability(row.comparison.movement.after)}
                    {' '}
                    {formatDeltaPp(row.comparison.movement.delta)}
                  </span>
                ) : null}
                {row.state === 'insufficient' ? (
                  <span className={css.eventPending} data-dshtrading-event-insufficient="">{t('prediction.eventInsufficient')}</span>
                ) : null}
                {row.state === 'uncovered' ? (
                  <span className={css.eventPending} data-dshtrading-event-uncovered="">{t('prediction.eventUncovered')}</span>
                ) : null}
                {row.state === 'history-error' ? (
                  <span className={css.error} data-dshtrading-event-error={row.code ?? ''}>{t('prediction.eventHistoryError')}</span>
                ) : null}
                {row.state === 'pending' ? (
                  <span className={css.eventPending}>{t('prediction.eventHistoryLoading')}</span>
                ) : null}
              </div>
            )
          }) : null}
        </div>
        {fetchedAt !== '' ? <div className={css.fetchedAt}>{t('prediction.fetchedAt')} {shortTime(Date.parse(fetchedAt))}</div> : null}
      </div>
    </div>
  )
}
