/**
 * finance 上游 wire 类型 + 视图派生纯函数（docs/api.md 契约，2026-09-17 实测取样）。
 * 纯数据/纯函数模块：零运行时依赖，host/client/测试三面共用。
 *
 * 纪律（docs/api.md「日期、缓存与错误处理」）：HTTP 200 只表示请求成功——
 * 各面板须展示 date/stale 滞后标记，null/空数组不补成数值零。
 */

/* ---------------------------------- 基差 ---------------------------------- */

/** 单产品日内统计（/api/snapshot stats.<key>）。 */
export interface BasisStat {
  min: number
  max: number
  mean: number
  last: number
  pct: number
  p25: number
  p75: number
  n: number
}

export interface BasisSnapshot {
  ready: boolean
  products: Array<{ key: string; name: string; last_spot?: number; last_fut?: number; last_dt?: string }>
  stats: Record<string, BasisStat | undefined>
}

export interface BasisHistoryPoint {
  date: string
  spot: number
  fut: number
  basis: number
  pct: number
}

export interface BasisHistory {
  schema_version: number
  data_date?: string
  basis: Record<string, BasisHistoryPoint[] | undefined>
}

/* --------------------------------- 恐慌指数 --------------------------------- */

export interface SentimentComponent {
  key: string
  name: string
  raw?: number | null
  score?: number | null
  unit?: string
  status?: string
  as_of?: string
  average_5d?: number | null
  vs_5d?: number | null
}

export interface SentimentSnapshot {
  market: string
  score: number
  label: string
  label_text: string
  date: string
  expected_data_date: string
  stale: boolean
  missing_components: string[]
  average_5d?: number | null
  vs_5d?: number | null
  components: SentimentComponent[]
  coverage: { valid: number; total: number; partial: boolean }
  methodology_version: number
}

export interface SentimentHistory {
  series: Array<{ date: string; score: number | null; label?: string; label_text?: string }>
  overlay: Array<{ date: string; close: number }>
  overlay_name?: string
  expected_data_date?: string
}

/** 0-100 分数的五档分区（与源页面口径一致：越低越恐惧）。 */
export type SentimentZone = 'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed'

export function sentimentZone(score: number): SentimentZone {
  if (score < 20) return 'extreme_fear'
  if (score < 40) return 'fear'
  if (score < 60) return 'neutral'
  if (score < 80) return 'greed'
  return 'extreme_greed'
}

/**
 * 「数据滞后」判据：上游数据日早于该指标的预期数据日才算滞后。
 *
 * T+1 口径下，交易日内显示上一交易日（T-1）数据是常态——融资余额、恐慌指数
 * 本身就要等次日才发布，10-09 显示 10-08 不是滞后。只有数据日真正落在预期
 * 交易日之前（如长假后迟迟未补、上游断更）才标记。日期为 ISO YYYY-MM-DD，
 * 字典序即时间序。任一日期缺失都不判滞后（宁可不标，不误标）。
 */
export function isDataBehind(dataDate: string | null | undefined, expectedDate: string | null | undefined): boolean {
  if (typeof dataDate !== 'string' || typeof expectedDate !== 'string') return false
  if (dataDate === '' || expectedDate === '') return false
  return dataDate < expectedDate
}

/** 恐慌指数快照的数据滞后（上游 date vs expected_data_date）。 */
export function sentimentDataStale(snapshot: SentimentSnapshot | undefined): boolean {
  return snapshot !== undefined && isDataBehind(snapshot.date, snapshot.expected_data_date)
}

/** 板块融资快照的数据滞后（上游 data_date vs expected_data_date）。 */
export function sectorsDataStale(snapshot: SectorsSnapshot | undefined): boolean {
  return snapshot !== undefined && isDataBehind(snapshot.data_date, snapshot.expected_data_date)
}

/* --------------------------------- 恒科卖空 --------------------------------- */

export interface HkShortSnapshot {
  ready: boolean
  data_date: string
  n_days: number
  n_stocks: number
  top10: Array<{ code: string; name: string; weight: number }>
  five_day: {
    current_pct: number
    average_pct: number
    pct_difference: number
    current_value: number
    average_value: number
    value_difference: number
    index_5d_pct: number
  }
}

export interface HkShortChart {
  short_ratio: Array<{ date: string; pct_turnover: number | null; value_hkd: number | null }>
  index: Array<{ date: string; close: number }>
  ratio_stats: { current_pct: number; avg_5d_pct: number; history_days: number }
  top10: Array<{
    code: string
    name: string
    weight: number
    latest_pct: number | null
    previous_pct?: number | null
    pct_delta?: number | null
    latest_value?: number | null
    avg_5d_pct?: number | null
    vs_5d_pct?: number | null
    history_days?: number
  }>
  stale: boolean
}

/* --------------------------------- 板块融资 --------------------------------- */

export interface SectorsSnapshot {
  sectors: Array<{ code: string; name: string; type: string }>
  data_date: string
  expected_data_date: string
  n_ready: number
  n_total: number
  missing_margin?: string[]
  stale_sectors?: string[]
  five_day?: { current_change: number; average_change: number; difference: number; total_flow: number; unit: string }
}

export interface SectorRankingRow {
  code: string
  name: string
  type: string
  chg_pct: number | null
  latest_margin: number | null
  latest_close?: number | null
  daily_change?: number | null
  avg_5d_change?: number | null
  vs_5d_change?: number | null
  total_5d_flow?: number | null
  index_5d_pct?: number | null
}

/** 单板块明细（/sectors/detail → /api/v2/sectors/{code}）：指数收盘 + 融资余额（元）日频序列。 */
export interface SectorDetail {
  code: string
  name: string
  type: string
  index: Array<{ date: string; close: number | null }>
  margin: Array<{ date: string; rzye: number | null }>
  stale: boolean
}

/* -------------------------------- 派生纯函数 -------------------------------- */

/** lightweight-charts 业务日期点。 */
export interface ChartPoint {
  time: string
  value: number
}

/** 日频序列 → 图表点：null 值丢弃（不补零，docs/api.md 纪律），按日期升序去重。 */
export function toChartSeries<T extends { date: string }>(rows: readonly T[], pick: (row: T) => number | null | undefined): ChartPoint[] {
  const seen = new Set<string>()
  const out: ChartPoint[] = []
  for (const row of rows) {
    if (seen.has(row.date)) continue
    const value = pick(row)
    if (value === null || value === undefined || !Number.isFinite(value)) continue
    seen.add(row.date)
    out.push({ time: row.date, value })
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
}

/** 百分数直出（上游已是百分数口径：1.5 表示 1.5%）。 */
export function formatPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(digits) + '%'
}

/** 带符号数值（vs_5d 等差值）。 */
export function formatSigned(value: number | null | undefined, digits = 2, suffix = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return (value > 0 ? '+' : '') + value.toFixed(digits) + suffix
}

/** 普通数值（基差点位等）。 */
export function formatNum(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

/**  HH:MM:SS 本地时间（工具栏「更新于」）。 */
export function formatClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}