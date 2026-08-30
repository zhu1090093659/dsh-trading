/**
 * Candlestick + MA + volume SVG chart. Renders from the pure layout in
 * chart-layout.ts; reports the hovered candle index to the parent (which owns
 * the OHLC readout). No canvas, no external chart library (host precedent:
 * SVG-only client bundles).
 */
import { useMemo, useState } from 'react'
import {
  AXIS_W, TIME_H, computeCandleLayout, priceY, volumeH,
} from './chart-layout.ts'
import { DOWN_COLOR, MA_COLORS, UP_COLOR, fmtAxis, fmtPrice } from './format.ts'
import type { Kline } from './types.ts'

export function CandleChart(props: {
  klines: readonly Kline[]
  width: number
  height: number
  intraday: boolean
  onHoverIndex: (index: number | null) => void
}): React.JSX.Element {
  const { klines, width, height, intraday, onHoverIndex } = props
  const [hover, setHover] = useState<number | null>(null)
  const layout = useMemo(() => computeCandleLayout(klines, width, height), [klines, width, height])

  if (layout === null) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8f99', fontSize: 13 }}>
        <span>{klines.length === 0 ? '…' : ''}</span>
      </div>
    )
  }

  const { visible, slot, bodyWidth, priceH, volTop, volH, priceMin, priceMax, volMax, plotW, maSeries } = layout
  const offset = klines.length - visible.length
  const gridLines = 5
  const timeTicks = 6

  const xOf = (index: number): number => index * slot + slot / 2

  const onMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    const index = Math.min(Math.max(Math.floor((event.clientX - box.left) / slot), 0), visible.length - 1)
    setHover(index)
    onHoverIndex(offset + index)
  }
  const onLeave = (): void => {
    setHover(null)
    onHoverIndex(null)
  }

  const hoverCandle = hover === null ? undefined : visible[hover]

  return (
    <svg
      width={width}
      height={height}
      role="img"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ display: 'block', userSelect: 'none' }}
    >
      {/* price gridlines + right axis labels */}
      {Array.from({ length: gridLines }, (_, index) => {
        const fraction = index / (gridLines - 1)
        const price = priceMax - (priceMax - priceMin) * fraction
        const y = priceY(price, layout)
        return (
          <g key={index}>
            <line x1={0} x2={plotW} y1={y} y2={y} stroke="#eceef1" strokeWidth={1} />
            <text x={plotW + 6} y={y + 4} fontSize={10} fill="#8a8f99">{fmtPrice(price)}</text>
          </g>
        )
      })}

      {/* volume reference line (max) */}
      <line x1={0} x2={plotW} y1={volTop} y2={volTop} stroke="#f2f3f5" strokeWidth={1} />

      {/* candles + volumes */}
      {visible.map((candle, index) => {
        const up = candle.close >= candle.open
        const color = up ? UP_COLOR : DOWN_COLOR
        const yOpen = priceY(candle.open, layout)
        const yClose = priceY(candle.close, layout)
        const bodyTop = Math.min(yOpen, yClose)
        const bodyH = Math.max(1, Math.abs(yClose - yOpen))
        const vh = volumeH(candle.volume, layout)
        return (
          <g key={candle.openTime}>
            <line x1={xOf(index)} x2={xOf(index)} y1={priceY(candle.high, layout)} y2={priceY(candle.low, layout)} stroke={color} strokeWidth={1} />
            <rect x={xOf(index) - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyH} fill={color} />
            <rect x={xOf(index) - bodyWidth / 2} y={volTop + volH - vh} width={bodyWidth} height={vh} fill={color} opacity={0.55} />
          </g>
        )
      })}

      {/* MA polylines */}
      {maSeries.map((series) => {
        const points = series.values
          .map((value, index) => value === undefined ? null : `${xOf(index).toFixed(2)},${priceY(value, layout).toFixed(2)}`)
          .filter((point): point is string => point !== null)
          .join(' ')
        if (points === '') return null
        return (
          <polyline
            key={series.period}
            points={points}
            fill="none"
            stroke={MA_COLORS[`MA${series.period}`] ?? '#8a8f99'}
            strokeWidth={1.1}
          />
        )
      })}

      {/* time axis */}
      {Array.from({ length: timeTicks }, (_, index) => {
        const raw = Math.floor(index * (visible.length - 1) / (timeTicks - 1))
        const candle = visible[raw] as Kline
        return (
          <text
            key={index}
            x={Math.min(Math.max(xOf(raw), 18), plotW - 18)}
            y={height - 6}
            fontSize={10}
            fill="#8a8f99"
            textAnchor="middle"
          >
            {fmtAxis(candle.openTime, intraday)}
          </text>
        )
      })}

      {/* crosshair */}
      {hover !== null && hoverCandle !== undefined && (
        <g pointerEvents="none">
          <line x1={xOf(hover)} x2={xOf(hover)} y1={0} y2={height - TIME_H} stroke="#b8bfc9" strokeWidth={1} strokeDasharray="3 3" />
          <line x1={0} x2={plotW} y1={priceY(hoverCandle.close, layout)} y2={priceY(hoverCandle.close, layout)} stroke="#b8bfc9" strokeWidth={1} strokeDasharray="3 3" />
          <rect
            x={plotW}
            y={priceY(hoverCandle.close, layout) - 8}
            width={AXIS_W}
            height={16}
            fill="#4a5568"
          />
          <text x={plotW + 6} y={priceY(hoverCandle.close, layout) + 4} fontSize={10} fill="#ffffff">{fmtPrice(hoverCandle.close)}</text>
        </g>
      )}
    </svg>
  )
}
