/**
 * Watchlist mini sparkline: a single normalized polyline of recent closes,
 * Futu-style. Pure SVG, no interaction surface (the row is the hit target).
 */
export function Sparkline(props: {
  values: readonly number[]
  width: number
  height: number
  up: boolean
}): React.JSX.Element {
  const { values, width, height, up } = props
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
  const points = values.map((value, index) => {
    const x = index * step
    const y = span === 0 ? height / 2 : (1 - (value - min) / span) * (height - 2) + 1
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const color = span === 0 ? '#8a8f99' : up ? '#e64545' : '#2ba471'
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.2} />
    </svg>
  )
}
