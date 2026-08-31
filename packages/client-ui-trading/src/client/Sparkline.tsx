/**
 * Watchlist mini sparkline: normalized polyline + gradient area fill,
 * Futu-style. Pure SVG, no interaction surface (the row is the hit target).
 */
import { useId } from 'react'
import { getColorPalette, type ColorMode } from './color-mode.ts'

export function Sparkline(props: {
  values: readonly number[]
  width: number
  height: number
  up: boolean
  colorMode?: ColorMode
}): React.JSX.Element {
  const { values, width, height, up, colorMode } = props
  const gradientId = useId()

  if (values.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />
  }

  let min = values[0] as number
  let max = values[0] as number
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }

  const span = max - min
  const step = width / (values.length - 1)
  const pts = values.map((value, index) => {
    const x = index * step
    const y = span === 0 ? height / 2 : (1 - (value - min) / span) * (height - 4) + 2
    return [x, y] as const
  })

  const strokePoints = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const areaPath = `M 0,${height} L ${pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L ')} L ${width},${height} Z`

  const palette = getColorPalette(colorMode)
  const strokeColor = span === 0 ? palette.flatColor : up ? palette.upColor : palette.downColor
  const gradColor = span === 0 ? 'rgba(138, 143, 153, 0.2)' : up ? palette.upAlpha(0.25) : palette.downAlpha(0.25)

  return (
    <svg width={width} height={height} aria-hidden="true" style={{ overflow: 'visible', display: 'block' }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={gradColor} stopOpacity="1" />
          <stop offset="100%" stopColor={gradColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <polyline points={strokePoints} fill="none" stroke={strokeColor} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
