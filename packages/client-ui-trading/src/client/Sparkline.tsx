/**
 * Watchlist mini sparkline: normalized polyline + gradient area fill,
 * Futu-style. Pure SVG, no interaction surface (the row is the hit target).
 */
import { memo, useId } from 'react'
import { getColorPalette, type ColorMode } from './color-mode.ts'

function SparklineImpl(props: {
  values: readonly number[]
  /** 可选：每点的 x 位置（0..1，固定交易时段口径）。缺省 = 等距铺满。 */
  xFractions?: readonly number[]
  width: number
  height: number
  up: boolean
  colorMode?: ColorMode
}): React.JSX.Element {
  const { values, xFractions, width, height, up, colorMode } = props
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
  const useFractions = xFractions !== undefined && xFractions.length === values.length
  const pts = values.map((value, index) => {
    const x = useFractions ? (xFractions[index] as number) * width : index * step
    const y = span === 0 ? height / 2 : (1 - (value - min) / span) * (height - 4) + 2
    return [x, y] as const
  })

  const strokePoints = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  // 面积填充只覆盖已绘制线段的水平范围（盘中固定时段轴下右侧留白）
  const firstX = (pts[0] as readonly [number, number])[0]
  const lastX = (pts[pts.length - 1] as readonly [number, number])[0]
  const areaPath = `M ${firstX.toFixed(2)},${height} L ${pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L ')} L ${lastX.toFixed(2)},${height} Z`

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

/**
 * Memo boundary: 自选行每 8s 行情轮询都会重渲染父面板，但迷你走势只由自身
 * 消费的 props 决定（序列数组引用、涨跌方向、色彩模式）。memo 让「价格数字变了、
 * 走势没变」的轮询不再重算 2×N 点的 path 字符串。
 */
export const Sparkline = memo(SparklineImpl)
