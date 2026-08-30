/**
 * Number/time formatting + the Futu color convention (红涨绿跌, matching the
 * reference UI) for the trading shell.
 */

/** Up = red, down = green (Futu convention). */
export const UP_COLOR = '#e64545'
export const DOWN_COLOR = '#2ba471'
export const FLAT_COLOR = '#8a8f99'

/** MA line palette (Futu-like). */
export const MA_COLORS: Record<string, string> = {
  MA5: '#e6b800',
  MA10: '#4a90e2',
  MA20: '#c05fd8',
}

export function directionColor(value: number): string {
  if (value > 0) return UP_COLOR
  if (value < 0) return DOWN_COLOR
  return FLAT_COLOR
}

/** Price decimals by magnitude (crypto sub-dollar pairs need more precision). */
export function fmtPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return value.toFixed(digits)
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

/** Compact volume: 万/亿 (Chinese convention, matching the reference UI). */
export function fmtCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${trimZeros((value / 1e8).toFixed(2))}亿`
  if (abs >= 1e4) return `${trimZeros((value / 1e4).toFixed(2))}万`
  if (abs >= 1000) return `${trimZeros((value / 1000).toFixed(2))}K`
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

/**
 * Change percent vs a reference close: (price - ref) / ref * 100.
 * Undefined when the reference is unusable (missing/non-positive).
 */
export function changePercent(price: number | undefined, reference: number | undefined): number | undefined {
  if (price === undefined || reference === undefined) return undefined
  if (!Number.isFinite(price) || !Number.isFinite(reference) || reference === 0) return undefined
  return (price - reference) / reference * 100
}
