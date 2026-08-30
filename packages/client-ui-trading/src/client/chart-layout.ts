/**
 * Candlestick chart layout math — pure and unit-testable. The renderer
 * (CandleChart.tsx) only maps this layout onto SVG elements.
 */
import type { Kline } from './types.ts'

/** Right-side price axis width. */
export const AXIS_W = 56
/** Bottom time-axis height. */
export const TIME_H = 22
/** Volume pane height as a fraction of the plot height. */
export const VOL_FRACTION = 0.16
/** Minimum horizontal slot per candle (drives the visible window). */
export const MIN_SLOT = 5
/** Smallest visible window. */
export const MIN_VISIBLE = 20

export interface MaSeries {
  period: number
  /** Aligned to the visible window; undefined during the warm-up. */
  values: ReadonlyArray<number | undefined>
}

export interface CandleLayout {
  visible: readonly Kline[]
  /** px per candle slot. */
  slot: number
  bodyWidth: number
  priceH: number
  volTop: number
  volH: number
  priceMin: number
  priceMax: number
  volMax: number
  plotW: number
  maSeries: readonly MaSeries[]
}

/** Simple moving average over the full series; undefined during warm-up. */
export function sma(values: readonly number[], period: number): ReadonlyArray<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined)
  if (period <= 0 || values.length < period) return out
  let sum = 0
  for (let index = 0; index < values.length; index++) {
    sum += values[index] as number
    if (index >= period) sum -= values[index - period] as number
    if (index >= period - 1) out[index] = sum / period
  }
  return out
}

/** Clamp helper. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Lay out the last N candles that fit the width. Returns null when there is
 * nothing drawable (no klines, or a degenerate width).
 */
export function computeCandleLayout(
  klines: readonly Kline[],
  width: number,
  height: number,
  maPeriods: readonly number[] = [5, 10, 20],
): CandleLayout | null {
  if (klines.length === 0 || width <= AXIS_W + MIN_SLOT || height <= TIME_H + 40) return null
  const plotW = width - AXIS_W
  const visibleN = clamp(Math.floor(plotW / MIN_SLOT), MIN_VISIBLE, klines.length)
  const visible = klines.slice(klines.length - visibleN)
  const slot = plotW / visibleN
  const bodyWidth = Math.max(1, Math.floor(slot * 0.62))

  const priceH = Math.round((height - TIME_H) * (1 - VOL_FRACTION)) - 8
  const volTop = priceH + 8
  const volH = height - TIME_H - volTop

  let priceMin = Infinity
  let priceMax = -Infinity
  let volMax = 0
  for (const candle of visible) {
    if (candle.low < priceMin) priceMin = candle.low
    if (candle.high > priceMax) priceMax = candle.high
    if (candle.volume > volMax) volMax = candle.volume
  }
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) return null
  if (priceMin === priceMax) {
    // Flat series: keep a visible band around the single price.
    priceMin -= Math.abs(priceMin) * 0.005 + 1e-8
    priceMax += Math.abs(priceMax) * 0.005 + 1e-8
  } else {
    const pad = (priceMax - priceMin) * 0.05
    priceMin -= pad
    priceMax += pad
  }

  const closes = klines.map(candle => candle.close)
  const maSeries = maPeriods.map((period) => {
    const full = sma(closes, period)
    return { period, values: full.slice(full.length - visibleN) }
  })

  return { visible, slot, bodyWidth, priceH, volTop, volH, priceMin, priceMax, volMax, plotW, maSeries }
}

/** Map a price to the plot's Y coordinate. */
export function priceY(price: number, layout: Pick<CandleLayout, 'priceMin' | 'priceMax' | 'priceH'>): number {
  const span = layout.priceMax - layout.priceMin
  return (1 - (price - layout.priceMin) / span) * layout.priceH
}

/** Map a volume to the volume pane's Y coordinate (height of the bar). */
export function volumeH(volume: number, layout: Pick<CandleLayout, 'volMax' | 'volH'>): number {
  if (layout.volMax <= 0) return 0
  return volume / layout.volMax * layout.volH
}
