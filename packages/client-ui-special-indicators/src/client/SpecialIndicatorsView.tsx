/**
 * 特殊指标主视图：自有 finance 服务（docs/api.md）四组指标，二级页签各展一组——
 *   1. A 股恐慌指数（score + 7 分项 + 与中证全指叠加的 250 日历史）
 *   2. IF / IM 期现基差（日内统计 + 250 日基差率历史）
 *   3. 恒科权重股卖空（聚合占比 + 指数叠加历史 + 成分股表）
 *   4. 板块融资余额（20 日变化率排行表 + 全板块 5 日净变化）
 *
 * 数据面：node 半 /dshtrading/api/special-indicators 桥（同源 fetch）；
 * 页签按需加载——status 握手后只拉当前页签的两个端点（首屏 8→2 个数据
 * 请求，冷缓存上游重算可达十几秒，finance-client 契约），页签首访拉取、
 * 回访命中已加载集零网络；手动刷新重拉全部已加载页签。
 * 每张卡片独立 Promise.allSettled 落地——单面板失败不拖垮整屏；
 * 更新时钟随每次落地走动。滞后/未就绪按上游字段如实标记，不补零不修饰。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchBasisHistory,
  fetchBasisSnapshot,
  fetchHkShortChart,
  fetchHkShortSnapshot,
  fetchSectorDetail,
  fetchSectorsRanking,
  fetchSectorsSnapshot,
  fetchSentimentHistory,
  fetchSentimentSnapshot,
  fetchStatus,
  type BridgeStatus,
} from './api.ts'
import { LineChart, type LineChartSeries } from './LineChart.tsx'
import type { SpecialIndicatorsLocaleKey } from './contract.ts'
import {
  formatClock,
  formatNum,
  formatPct,
  formatSigned,
  sentimentZone,
  toChartSeries,
  type BasisHistory,
  type BasisSnapshot,
  type SectorDetail,
  type HkShortChart,
  type HkShortSnapshot,
  type SectorRankingRow,
  type SectorsSnapshot,
  type SentimentHistory,
  type SentimentSnapshot,
} from './wire.ts'
import css from './SpecialIndicatorsView.module.css'

/** CSS Modules 类表在 noUncheckedIndexedAccess 下索引为 string|undefined；
 *  运行期类名恒存在（构建期类表契约），此处把类型面收敛为 string。 */
const cx = (name: string): string => css[name] ?? name

type TFunc = (key: SpecialIndicatorsLocaleKey, params?: Record<string, unknown>) => string

export interface SpecialIndicatorsViewProps {
  t: TFunc
  /** 中栏当前视图 id（本视图无跨视图状态，仅保持签名一致）。 */
  view: string
}

interface Panel<T> {
  data?: T
  error?: string
}

interface Dashboard {
  basisSnap?: Panel<BasisSnapshot>
  basisHist?: Panel<BasisHistory>
  sentimentSnap?: Panel<SentimentSnapshot>
  sentimentHist?: Panel<SentimentHistory>
  hkSnap?: Panel<HkShortSnapshot>
  hkChart?: Panel<HkShortChart>
  sectorsSnap?: Panel<SectorsSnapshot>
  sectorsRanking?: Panel<SectorRankingRow[]>
}

const SENTIMENT_DAYS = 250
const BASIS_DAYS = 250
const SECTOR_WINDOW = 20
/** 单板块明细历史跨度（约 14 个月日频，对齐 finance 页面区间观感）。 */
const SECTOR_DETAIL_DAYS = 300

/** 二级页签（每个页签一组指标）；持久化与 MiddleStage 同款 localStorage 契约。 */
const SUBTAB_IDS = ['sentiment', 'basis', 'hkshort', 'sectors'] as const
type SubTabId = (typeof SUBTAB_IDS)[number]
const SUBTAB_KEY = 'dshtrading.special-indicators.tab.v1'

function readSubTab(): SubTabId {
  try {
    const raw = window.localStorage.getItem(SUBTAB_KEY)
    const value = raw === null ? null : (JSON.parse(raw) as unknown)
    return (SUBTAB_IDS as readonly string[]).includes(value as string) ? (value as SubTabId) : 'sentiment'
  } catch {
    return 'sentiment'
  }
}

function writeSubTab(id: SubTabId): void {
  try {
    window.localStorage.setItem(SUBTAB_KEY, JSON.stringify(id))
  } catch {
    // 隐私模式等写失败：页签仍可用，仅不持久化。
  }
}

const ZONE_BADGE: Record<string, string> = {
  extreme_fear: cx('badgeFear'),
  fear: cx('badgeFear'),
  neutral: cx('badgeNeutral'),
  greed: cx('badgeGreed'),
  extreme_greed: cx('badgeGreed'),
}

/** 涨跌着色（本仓 CN 口径：红涨绿跌，与 StrategyView 一致）。 */
function trendClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return cx('numFlat')
  return value > 0 ? cx('numUp') : cx('numDown')
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const panelOf = <T,>(r: PromiseSettledResult<T>): Panel<T> =>
  r.status === 'fulfilled' ? { data: r.value } : { error: errMessage(r.reason) }

/** 每页签两个端点，allSettled 面板隔离（单面板失败不拖垮同页签另一张卡）。 */
const TAB_FETCHERS: Record<SubTabId, () => Promise<Partial<Dashboard>>> = {
  sentiment: async () => {
    const [snap, hist] = await Promise.allSettled([fetchSentimentSnapshot(), fetchSentimentHistory(SENTIMENT_DAYS)])
    return { sentimentSnap: panelOf(snap), sentimentHist: panelOf(hist) }
  },
  basis: async () => {
    const [snap, hist] = await Promise.allSettled([fetchBasisSnapshot(), fetchBasisHistory(BASIS_DAYS)])
    return { basisSnap: panelOf(snap), basisHist: panelOf(hist) }
  },
  hkshort: async () => {
    const [snap, chart] = await Promise.allSettled([fetchHkShortSnapshot(), fetchHkShortChart()])
    return { hkSnap: panelOf(snap), hkChart: panelOf(chart) }
  },
  sectors: async () => {
    const [snap, ranking] = await Promise.allSettled([fetchSectorsSnapshot(), fetchSectorsRanking(SECTOR_WINDOW)])
    return { sectorsSnap: panelOf(snap), sectorsRanking: panelOf(ranking) }
  },
}

export function SpecialIndicatorsView({ t }: SpecialIndicatorsViewProps) {
  const [tab, setTab] = useState<SubTabId>(readSubTab)
  const [status, setStatus] = useState<Panel<BridgeStatus>>({})
  const [dash, setDash] = useState<Dashboard>({})
  // 加载指示 = 在途页签请求计数（并发 ensureTab 下不错位）。
  const [pending, setPending] = useState(0)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  // 已加载页签集（回访零网络）+ 每页签 in-flight 去重（快速切换/重复刷新
  // 复用同一次落地；注入式状态机，不睡不轮询）。
  const loadedRef = useRef<Set<SubTabId>>(new Set())
  const inflightRef = useRef<Map<SubTabId, Promise<void>>>(new Map())
  const statusInflightRef = useRef<Promise<Panel<BridgeStatus>> | null>(null)

  // status 握手：在途复用（刷新连点不翻倍），落定即放行下一次——
  // 不缓存失败面板，刷新总能重新握手。
  const loadStatus = useCallback((): Promise<Panel<BridgeStatus>> => {
    const existing = statusInflightRef.current
    if (existing !== null) return existing
    const run = fetchStatus()
      .then((st): Panel<BridgeStatus> => {
        const p: Panel<BridgeStatus> = { data: st }
        setStatus(p)
        return p
      })
      .catch((error: unknown): Panel<BridgeStatus> => {
        const p: Panel<BridgeStatus> = { error: errMessage(error) }
        setStatus(p)
        return p
      })
      .finally(() => {
        statusInflightRef.current = null
      })
    statusInflightRef.current = run
    return run
  }, [])

  const ensureTab = useCallback((id: SubTabId, force = false): Promise<void> => {
    const existing = inflightRef.current.get(id)
    if (existing !== undefined) return existing
    if (!force && loadedRef.current.has(id)) return Promise.resolve()
    loadedRef.current.add(id)
    setPending((n) => n + 1)
    const run = TAB_FETCHERS[id]()
      .then((slice) => {
        setDash((prev) => ({ ...prev, ...slice }))
        setUpdatedAt(new Date())
      })
      .finally(() => {
        inflightRef.current.delete(id)
        setPending((n) => n - 1)
      })
    inflightRef.current.set(id, run)
    return run
  }, [])

  // 首屏：status 桥握手——未配置/故障分支不发起任何数据子路由请求。
  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // 页签按需加载：configured 后激活页签首访拉取自身端点；回访命中
  // loadedRef 零网络（页签状态在视图存活期内保留，整视图卸载后重来，
  // host 半 TTL 缓存兜住重挂载成本）。
  const configured = status.data?.configured === true
  useEffect(() => {
    if (configured) void ensureTab(tab)
  }, [configured, tab, ensureTab])

  // 手动刷新：重握手 status + 重拉全部已加载页签（未访问页签不预拉）。
  const refresh = useCallback((): void => {
    void loadStatus().then((p) => {
      if (p.data?.configured !== true) return
      for (const id of loadedRef.current) void ensureTab(id, true)
    })
  }, [loadStatus, ensureTab])

  const loading = pending > 0

  /* --------------------------------- 工具栏 --------------------------------- */

  const toolbar = (
    <div className={cx('toolbar')}>
      <span className={cx('toolbarSpacer')} />
      {updatedAt !== null && <span className={cx('clock')}>{t('si.updatedAt', { time: formatClock(updatedAt) })}</span>}
      <button type="button" className={cx('refreshBtn')} onClick={refresh} disabled={loading}>
        {loading ? t('si.refreshing') : t('si.refresh')}
      </button>
    </div>
  )

  if (status.data !== undefined && !status.data.configured) {
    return (
      <div className={cx('root')}>
        {toolbar}
        <div className={cx('placeholder')}>
          <div className={cx('placeholderTitle')}>{t('si.unconfigured.title')}</div>
          <div className={cx('placeholderHint')}>{t('si.unconfigured.hint')}</div>
        </div>
      </div>
    )
  }
  if (status.error !== undefined) {
    return (
      <div className={cx('root')}>
        {toolbar}
        <div className={cx('placeholder')}>
          <div className={cx('placeholderTitle')}>{t('si.error.load', { message: status.error })}</div>
        </div>
      </div>
    )
  }

  const SUBTAB_LABELS: Record<SubTabId, SpecialIndicatorsLocaleKey> = {
    sentiment: 'si.sentiment.title',
    basis: 'si.basis.title',
    hkshort: 'si.hkshort.title',
    sectors: 'si.sectors.title',
  }
  const switchTab = (id: SubTabId): void => {
    setTab(id)
    writeSubTab(id)
  }
  return (
    <div className={cx('root')}>
      {toolbar}
      <div className={cx('subtabs')} role="tablist" aria-label="special-indicators">
        {SUBTAB_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === tab}
            className={id === tab ? cx('subtabActive') : cx('subtab')}
            onClick={() => switchTab(id)}
          >
            {t(SUBTAB_LABELS[id])}
          </button>
        ))}
      </div>
      <div className={cx('panel')}>
        {tab === 'sentiment' && <SentimentCard t={t} snap={dash.sentimentSnap} hist={dash.sentimentHist} loading={loading} />}
        {tab === 'basis' && <BasisCard t={t} snap={dash.basisSnap} hist={dash.basisHist} loading={loading} />}
        {tab === 'hkshort' && <HkShortCard t={t} snap={dash.hkSnap} chart={dash.hkChart} loading={loading} />}
        {tab === 'sectors' && <SectorsCard t={t} snap={dash.sectorsSnap} ranking={dash.sectorsRanking} loading={loading} />}
      </div>
    </div>
  )
}

/* --------------------------------- 卡片骨架 --------------------------------- */

function CardShell({ title, subtitle, date, stale, error, loading, children, t }: {
  t: TFunc
  title: string
  subtitle: string
  date?: string | undefined
  stale?: boolean | undefined
  error?: string | undefined
  loading: boolean
  children?: React.ReactNode
}) {
  return (
    <section className={cx('card')}>
      <header className={cx('cardHeader')}>
        <div>
          <div className={cx('cardTitle')}>{title}</div>
          <div className={cx('cardSubtitle')}>{subtitle}</div>
        </div>
        <div className={cx('cardHeaderRight')}>
          {stale === true && <span className={cx('badgeStale')}>{t('si.stale')}</span>}
          {date !== undefined && date !== '' && <span className={cx('cardDate')}>{date}</span>}
        </div>
      </header>
      {error !== undefined
        ? <div className={cx('errorLine')}>{t('si.error.load', { message: error })}</div>
        : children ?? (loading ? <div className={cx('loadingLine')}>{t('si.loading')}</div> : null)}
    </section>
  )
}

/* --------------------------------- 恐慌指数 --------------------------------- */

function SentimentCard({ t, snap, hist, loading }: {
  t: TFunc
  snap?: Panel<SentimentSnapshot> | undefined
  hist?: Panel<SentimentHistory> | undefined
  loading: boolean
}) {
  const s = snap?.data
  const zone = s !== undefined ? sentimentZone(s.score) : undefined
  const zoneKey = ('si.sentiment.label.' + (s?.label ?? '')) as SpecialIndicatorsLocaleKey
  const knownLabel = s !== undefined && ['extreme_fear', 'fear', 'neutral', 'greed', 'extreme_greed'].includes(s.label)
  // series 引用稳定化：LineChart 以引用变化为重建信号，useMemo 把重建收敛
  // 到数据真正更新时（其余重渲染不再整图销毁重建，SectorsCard 行点击同款）。
  const series = useMemo<LineChartSeries[]>(() => {
    if (hist?.data === undefined) return []
    return [
      { id: 'score', points: toChartSeries(hist.data.series, (r) => r.score), color: '#5b8def', area: true, title: t('si.sentiment.scoreLine') },
      { id: 'overlay', points: toChartSeries(hist.data.overlay, (r) => r.close), color: '#8e95a3', scale: 'left', title: t('si.sentiment.indexOverlay') },
    ]
  }, [hist?.data, t])
  return (
    <CardShell
      t={t}
      title={t('si.sentiment.title')}
      subtitle={t('si.sentiment.subtitle')}
      date={s?.date}
      stale={s?.stale}
      error={snap?.error ?? hist?.error}
      loading={loading}
    >
      {s === undefined
        ? <div className={cx('loadingLine')}>{t('si.loading')}</div>
        : (
          <>
            <div className={cx('statRow')}>
              <span className={cx('bigNumber')}>{formatNum(s.score, 1)}</span>
              <span className={(zone !== undefined ? ZONE_BADGE[zone] : undefined) ?? cx('badgeNeutral')}>{knownLabel ? t(zoneKey) : s.label_text}</span>
              <span className={cx('statItem')}>{t('si.sentiment.avg5d')} {formatNum(s.average_5d, 1)}</span>
              <span className={cx('statItem') + ' ' + trendClass(s.vs_5d)}>{t('si.sentiment.vs5d')} {formatSigned(s.vs_5d, 1)}</span>
            </div>
            <div className={cx('components')}>
              <div className={cx('componentsTitle')}>
                {t('si.sentiment.components', { valid: s.coverage.valid, total: s.coverage.total })}
              </div>
              {s.components.map((c) => (
                <div key={c.key} className={cx('componentRow')}>
                  <span className={cx('componentName')}>{c.name}</span>
                  <span className={cx('componentBarTrack')}>
                    <span
                      className={cx('componentBarFill')}
                      style={{ width: Math.max(0, Math.min(100, c.score ?? 0)) + '%' }}
                    />
                  </span>
                  <span className={cx('componentScore')}>{formatNum(c.score, 0)}</span>
                </div>
              ))}
            </div>
            {series.some((x) => x.points.length > 0) && <LineChart series={series} />}
          </>
        )}
    </CardShell>
  )
}

/* ---------------------------------- 基差 ---------------------------------- */

function BasisCard({ t, snap, hist, loading }: {
  t: TFunc
  snap?: Panel<BasisSnapshot> | undefined
  hist?: Panel<BasisHistory> | undefined
  loading: boolean
}) {
  const s = snap?.data
  const series = useMemo<LineChartSeries[]>(() => {
    if (hist?.data === undefined) return []
    return [
      { id: 'IF', points: toChartSeries(hist.data.basis.IF ?? [], (r) => r.pct), color: '#5b8def', title: 'IF' },
      { id: 'IM', points: toChartSeries(hist.data.basis.IM ?? [], (r) => r.pct), color: '#d4a017', title: 'IM' },
    ]
  }, [hist?.data])
  return (
    <CardShell
      t={t}
      title={t('si.basis.title')}
      subtitle={t('si.basis.subtitle')}
      date={hist?.data?.data_date}
      error={snap?.error ?? hist?.error}
      loading={loading}
    >
      {s === undefined
        ? <div className={cx('loadingLine')}>{t('si.loading')}</div>
        : (
          <>
            <div className={cx('basisGrid')}>
              {s.products.map((p) => {
                const stat = s.stats[p.key]
                return (
                  <div key={p.key} className={cx('basisProduct')}>
                    <div className={cx('basisProductName')}>{p.key} {p.name}</div>
                    <div className={cx('statRow')}>
                      <span className={cx('statItem')}>{t('si.basis.last')} <b>{formatNum(stat?.last, 1)}</b></span>
                      <span className={cx('statItem')}>{t('si.basis.pct')} <b>{formatPct(stat?.pct)}</b></span>
                    </div>
                    <div className={cx('statRow')}>
                      <span className={cx('statItem')}>{t('si.basis.mean')} {formatNum(stat?.mean, 1)}</span>
                      <span className={cx('statItem')}>{t('si.basis.range')} {formatNum(stat?.min, 1)} ~ {formatNum(stat?.max, 1)}</span>
                    </div>
                    <div className={cx('statRow')}>
                      <span className={cx('statItem')}>{t('si.basis.spot')} {formatNum(p.last_spot, 1)}</span>
                      <span className={cx('statItem')}>{t('si.basis.fut')} {formatNum(p.last_fut, 1)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className={cx('chartCaption')}>{t('si.basis.historyPct', { days: BASIS_DAYS })}</div>
            {series.some((x) => x.points.length > 0) && <LineChart series={series} />}
          </>
        )}
    </CardShell>
  )
}

/* --------------------------------- 恒科卖空 --------------------------------- */

function HkShortCard({ t, snap, chart, loading }: {
  t: TFunc
  snap?: Panel<HkShortSnapshot> | undefined
  chart?: Panel<HkShortChart> | undefined
  loading: boolean
}) {
  const s = snap?.data
  const c = chart?.data
  const series = useMemo<LineChartSeries[]>(() => {
    if (c === undefined) return []
    return [
      { id: 'ratio', points: toChartSeries(c.short_ratio, (r) => r.pct_turnover), color: '#5b8def', area: true, title: t('si.hkshort.ratioLine') },
      { id: 'index', points: toChartSeries(c.index, (r) => r.close), color: '#8e95a3', scale: 'left', title: t('si.hkshort.indexLine') },
    ]
  }, [c, t])
  return (
    <CardShell
      t={t}
      title={t('si.hkshort.title')}
      subtitle={t('si.hkshort.subtitle')}
      date={s?.data_date}
      stale={c?.stale}
      error={snap?.error ?? chart?.error}
      loading={loading}
    >
      {s === undefined
        ? <div className={cx('loadingLine')}>{t('si.loading')}</div>
        : (
          <>
            <div className={cx('statRow')}>
              <span className={cx('bigNumber')}>{formatPct(s.five_day.current_pct)}</span>
              <span className={cx('statItem')}>{t('si.hkshort.avg5d')} {formatPct(s.five_day.average_pct)}</span>
              <span className={cx('statItem') + ' ' + trendClass(s.five_day.pct_difference)}>{t('si.hkshort.diff')} {formatSigned(s.five_day.pct_difference, 2)}</span>
            </div>
            <div className={cx('statRow')}>
              <span className={cx('statItem') + ' ' + trendClass(s.five_day.value_difference)}>{t('si.hkshort.value5d')} {formatSigned(s.five_day.value_difference, 1)}</span>
              <span className={cx('statItem') + ' ' + trendClass(s.five_day.index_5d_pct)}>{t('si.hkshort.index5d')} {formatSigned(s.five_day.index_5d_pct, 2, '%')}</span>
            </div>
            {series.some((x) => x.points.length > 0) && <LineChart series={series} />}
            {c !== undefined && c.top10.length > 0 && (
              <table className={cx('table')}>
                <caption className={cx('tableCaption')}>{t('si.hkshort.top10', { count: c.top10.length })}</caption>
                <thead>
                  <tr>
                    <th>{t('si.hkshort.col.name')}</th>
                    <th className={cx('numCell')}>{t('si.hkshort.col.weight')}</th>
                    <th className={cx('numCell')}>{t('si.hkshort.col.latestPct')}</th>
                    <th className={cx('numCell')}>{t('si.hkshort.col.vs5d')}</th>
                  </tr>
                </thead>
                <tbody>
                  {c.top10.map((row) => (
                    <tr key={row.code}>
                      <td>{row.name}</td>
                      <td className={cx('numCell')}>{formatNum(row.weight, 1)}</td>
                      <td className={cx('numCell')}>{formatPct(row.latest_pct)}</td>
                      <td className={cx('numCell') + ' ' + trendClass(row.vs_5d_pct)}>{formatSigned(row.vs_5d_pct, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
    </CardShell>
  )
}

/* --------------------------------- 板块融资 --------------------------------- */

function SectorsCard({ t, snap, ranking, loading }: {
  t: TFunc
  snap?: Panel<SectorsSnapshot> | undefined
  ranking?: Panel<SectorRankingRow[]> | undefined
  loading: boolean
}) {
  const s = snap?.data
  const rows = ranking?.data
  // 选中板块：缺省第一名（与 finance 页面同口径），点击行切换；
  // 明细请求带序号闸，快速连点时丢弃过期响应（不睡不轮询）。
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Panel<SectorDetail>>({})
  const [detailLoading, setDetailLoading] = useState(false)
  const requestRef = useRef(0)
  const activeCode = selected ?? rows?.[0]?.code ?? null

  useEffect(() => {
    if (activeCode === null) return
    const seq = ++requestRef.current
    setDetailLoading(true)
    fetchSectorDetail(activeCode, SECTOR_DETAIL_DAYS)
      .then((data) => { if (requestRef.current === seq) setDetail({ data }) })
      .catch((error: unknown) => { if (requestRef.current === seq) setDetail({ error: errMessage(error) }) })
      .finally(() => { if (requestRef.current === seq) setDetailLoading(false) })
  }, [activeCode])

  const d = detail.data
  // 行点击只换 activeCode 时 detail.data 未变：useMemo 保住 series 引用，
  // 明细图不随行选中态重渲染而销毁重建（300 点 × 2 序列 + fitContent）。
  const series = useMemo<LineChartSeries[]>(() => [
    { id: 'margin', points: toChartSeries(d?.margin ?? [], (r) => (r.rzye === null ? null : r.rzye / 1e8)), color: '#5b8def', area: true, title: t('si.sectors.marginLine') },
    { id: 'index', points: toChartSeries(d?.index ?? [], (r) => r.close), color: '#d4a017', scale: 'left', title: t('si.sectors.indexLine') },
  ], [d, t])
  const lastDate = d?.margin[d.margin.length - 1]?.date

  return (
    <CardShell
      t={t}
      title={t('si.sectors.title')}
      subtitle={t('si.sectors.subtitle', { window: SECTOR_WINDOW })}
      date={s?.data_date}
      error={snap?.error ?? ranking?.error}
      loading={loading}
    >
      {s === undefined || rows === undefined
        ? <div className={cx('loadingLine')}>{t('si.loading')}</div>
        : (
          <>
            <div className={cx('statRow')}>
              <span className={cx('statItem')}>{t('si.sectors.coverage', { ready: s.n_ready, total: s.n_total })}</span>
              {s.five_day !== undefined && (
                <span className={cx('statItem') + ' ' + trendClass(s.five_day.total_flow)}>
                  {t('si.sectors.flow5d', { value: formatSigned(s.five_day.total_flow, 1) })}
                </span>
              )}
            </div>
            <div className={cx('sectorLayout')}>
              <div className={cx('sectorTable') + ' ' + cx('tableScroll')}>
                <table className={cx('table')}>
                  <thead>
                    <tr>
                      <th>{t('si.sectors.col.name')}</th>
                      <th className={cx('numCell')}>{t('si.sectors.col.chgPct')}</th>
                      <th className={cx('numCell')}>{t('si.sectors.col.margin')}</th>
                      <th className={cx('numCell')}>{t('si.sectors.col.daily')}</th>
                      <th className={cx('numCell')}>{t('si.sectors.col.flow5d')}</th>
                      <th className={cx('numCell')}>{t('si.sectors.col.index5d')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.code}
                        className={row.code === activeCode ? cx('rowClickable') + ' ' + cx('rowSelected') : cx('rowClickable')}
                        aria-selected={row.code === activeCode}
                        onClick={() => setSelected(row.code)}
                      >
                        <td>{row.name}</td>
                        <td className={cx('numCell') + ' ' + trendClass(row.chg_pct)}>{formatSigned(row.chg_pct, 2, '%')}</td>
                        <td className={cx('numCell')}>{formatNum(row.latest_margin, 1)}</td>
                        <td className={cx('numCell') + ' ' + trendClass(row.daily_change)}>{formatSigned(row.daily_change, 2)}</td>
                        <td className={cx('numCell') + ' ' + trendClass(row.total_5d_flow)}>{formatSigned(row.total_5d_flow, 2)}</td>
                        <td className={cx('numCell') + ' ' + trendClass(row.index_5d_pct)}>{formatSigned(row.index_5d_pct, 2, '%')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={cx('sectorChart')}>
                {detail.error !== undefined && <div className={cx('errorLine')}>{detail.error}</div>}
                {detail.error === undefined && (
                  <>
                    <div className={cx('sectorChartHead')}>
                      <span className={cx('sectorChartName')}>{d?.name ?? rows.find((r) => r.code === activeCode)?.name ?? ''}</span>
                      <span className={cx('cardDate')}>
                        {d?.stale === true && <span className={cx('badgeStale')}>{t('si.stale')}</span>}
                        {' ' + t('si.sectors.asOf', { date: lastDate ?? '—' })}
                      </span>
                    </div>
                    {detailLoading && d === undefined && <div className={cx('loadingLine')}>{t('si.loading')}</div>}
                    {series.some((x) => x.points.length > 0) && <LineChart series={series} />}
                  </>
                )}
              </div>
            </div>
          </>
        )}
    </CardShell>
  )
}