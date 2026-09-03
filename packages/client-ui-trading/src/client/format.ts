import { getColorPalette, type ColorMode } from './color-mode.ts'

/** Default red-up constants for backward compatibility. */
export const UP_COLOR = '#e64545'
export const DOWN_COLOR = '#2ba471'
export const FLAT_COLOR = '#8a8f99'

export function directionColor(value: number, mode: ColorMode = 'red-up'): string {
  const palette = getColorPalette(mode)
  if (value > 0) return palette.upColor
  if (value < 0) return palette.downColor
  return palette.flatColor
}

/** Price decimals by magnitude (crypto sub-dollar pairs need more precision). */
export function priceDigits(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 2
  const abs = Math.abs(value)
  if (abs >= 1000) return 2
  if (abs >= 1) return 2
  if (abs >= 0.01) return 4
  return 6
}

export function fmtPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(priceDigits(value))
}

/** Signed percent string: +1.74% / -0.83% / 0.00%. */
export function fmtPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

/** Signed absolute change string. */
export function fmtChange(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : '-'
  return `${sign}${fmtPrice(Math.abs(value))}`
}

/** Compact volume locale: zh = 万/亿 (Chinese convention), en = K/M/B. */
export type CompactLocale = 'zh' | 'en'

/** Active locale id → compact-unit locale（未知 id 回落 zh，与现网中文口径一致）。 */
export function compactLocaleOf(localeId: string): CompactLocale {
  return localeId.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * 词典哨兵键（dshtrading.market 'fundamentals.scale'）→ 数值单位 locale。
 * t 不携带 active locale 元数据，UI 层从词典值判定（zh 值固定 '万'，en 固定 'B'）；
 * 该键只作哨兵，不在 UI 渲染。两个哨兵值都识别（评审 L2：只认 '万' 时，词典
 * 改词/键位 miss 返回 key 本身会把 zh 静默翻成 en 单位）；未知值告警并回落 en
 * （B/M/K 是国际默认，对 zh 用户是可读降级）。
 */
export function scaleLocaleOf(t: (key: 'fundamentals.scale', params?: Record<string, unknown>) => string): CompactLocale {
  const value = t('fundamentals.scale')
  if (value === '万') return 'zh' // i18n-allow: 哨兵值与 zh 词典字面量比对
  if (value === 'B') return 'en'
  console.warn(`[dsh-trading] unexpected fundamentals.scale sentinel: ${JSON.stringify(value)}; falling back to en units`)
  return 'en'
}

/** Compact volume (locale-aware units, matching the reference UI). */
export function fmtCompact(value: number | undefined, locale: CompactLocale = 'zh'): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (locale === 'zh') {
    if (abs >= 1e8) return `${trimZeros((value / 1e8).toFixed(2))}亿` // i18n-allow: zh 数值单位常量（locale 数据）
    if (abs >= 1e4) return `${trimZeros((value / 1e4).toFixed(2))}万` // i18n-allow: zh 数值单位常量（locale 数据）
    if (abs >= 1000) return `${trimZeros((value / 1000).toFixed(2))}K`
    return trimZeros(value.toFixed(2))
  }
  if (abs >= 1e9) return `${trimZeros((value / 1e9).toFixed(2))}B`
  if (abs >= 1e6) return `${trimZeros((value / 1e6).toFixed(2))}M`
  if (abs >= 1e3) return `${trimZeros((value / 1e3).toFixed(2))}K`
  return trimZeros(value.toFixed(2))
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/** HH:mm:ss for quote timestamps. */
export function fmtClock(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** MM-DD for daily chart axis; HH:mm for intraday. */
export function fmtAxis(ms: number, intraday: boolean): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (intraday) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const INTRADAY_INTERVALS: ReadonlySet<string> = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h'])

/** 资金费率结算倒计时（issue #54）：>1h 显示 "7h 32m"，<1h 显示 "32m 10s"；过期返回 undefined。 */
export function fmtCountdown(targetMs: number | undefined, nowMs: number): string | undefined {
  if (targetMs === undefined || !Number.isFinite(targetMs)) return undefined
  const remain = targetMs - nowMs
  if (remain <= 0) return undefined
  const totalSec = Math.floor(remain / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}h ${pad(m)}m` : `${pad(m)}m ${pad(s)}s`
}

/** 资金费率百分比（小数 → 4 位百分比字符串，如 0.0001 → "0.0100%"）。 */
export function fmtFundingRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(4)}%`
}

/**
 * Change percent vs a reference close: (price - ref) / ref * 100.
 * Undefined when the reference is unusable (missing/non-positive).
 */
export function changePercent(price: number | undefined, reference: number | undefined): number | undefined {
  if (price === undefined || reference === undefined) return undefined
  if (!Number.isFinite(price) || !Number.isFinite(reference) || reference === 0) return undefined
  return (price - reference) / reference * 100
}
