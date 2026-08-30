/**
 * 预置指标（仿富途：主图 MA/EMA/BOLL，副图 MACD/RSI/KDJ）。
 * 全部是 definition 数据 + math.ts 纯函数的组合，无渲染逻辑。
 */
import { MA_COLORS } from '../format.ts'
import type { Kline } from '../types.ts'
import { bollinger, ema, kdj, macd, rsi, sma } from './math.ts'
import { registerIndicator } from './registry.ts'

/** 任意周期均线的取色：命中富途三色用之，否则按周期轮换调色板。 */
const FALLBACK_PALETTE: readonly string[] = ['#e6b800', '#4a90e2', '#c05fd8', '#f97316', '#0ea5e9']

function maColor(period: number): string {
  return MA_COLORS[`MA${period}`] ?? FALLBACK_PALETTE[period % FALLBACK_PALETTE.length] ?? '#8a8f99'
}

const closesOf = (bars: readonly Kline[]): number[] => bars.map(bar => bar.close)

/** MA：一组三条均线（周期可调，默认 5/10/20 —— 与退役的 SVG 图表一致）。 */
registerIndicator({
  id: 'ma',
  pane: 'main',
  titleKey: 'indicator.ma',
  params: [
    { key: 'n1', labelKey: 'indicator.param.p1', default: 5, min: 1, max: 250 },
    { key: 'n2', labelKey: 'indicator.param.p2', default: 10, min: 1, max: 250 },
    { key: 'n3', labelKey: 'indicator.param.p3', default: 20, min: 1, max: 250 },
  ],
  compute(bars, params) {
    const closes = closesOf(bars)
    return ([params.n1, params.n2, params.n3] as const).map((period) => ({
      key: `MA${period}`,
      kind: 'line' as const,
      color: maColor(period),
      values: sma(closes, period),
    }))
  },
})

/** EMA：两条指数均线（12/26，与 MACD 默认周期呼应）。 */
registerIndicator({
  id: 'ema',
  pane: 'main',
  titleKey: 'indicator.ema',
  params: [
    { key: 'n1', labelKey: 'indicator.param.p1', default: 12, min: 1, max: 250 },
    { key: 'n2', labelKey: 'indicator.param.p2', default: 26, min: 1, max: 250 },
  ],
  compute(bars, params) {
    const closes = closesOf(bars)
    return ([params.n1, params.n2] as const).map((period, index) => ({
      key: `EMA${period}`,
      kind: 'line' as const,
      color: index === 0 ? '#ff9800' : '#00bcd4',
      values: ema(closes, period),
    }))
  },
})

/** BOLL：中轨 + 上下轨（20, ×2）。 */
registerIndicator({
  id: 'boll',
  pane: 'main',
  titleKey: 'indicator.boll',
  params: [
    { key: 'n', labelKey: 'indicator.param.period', default: 20, min: 2, max: 250 },
    { key: 'k', labelKey: 'indicator.param.mult', default: 2, min: 1, max: 5 },
  ],
  compute(bars, params) {
    const { mid, upper, lower } = bollinger(closesOf(bars), params.n, params.k)
    return [
      { key: 'MID', kind: 'line', color: '#8a8f99', values: mid },
      { key: 'UP', kind: 'line', color: '#4a90e2', values: upper },
      { key: 'LOW', kind: 'line', color: '#4a90e2', values: lower },
    ]
  },
})

/** MACD：DIF/DEA 线 + 按符号红涨绿跌的柱（12,26,9）。 */
registerIndicator({
  id: 'macd',
  pane: 'sub',
  titleKey: 'indicator.macd',
  params: [
    { key: 'fast', labelKey: 'indicator.param.fast', default: 12, min: 2, max: 100 },
    { key: 'slow', labelKey: 'indicator.param.slow', default: 26, min: 2, max: 200 },
    { key: 'signal', labelKey: 'indicator.param.signal', default: 9, min: 1, max: 60 },
  ],
  compute(bars, params) {
    const { dif, dea, hist } = macd(closesOf(bars), params.fast, params.slow, params.signal)
    return [
      { key: 'DIF', kind: 'line', color: '#e6b800', values: dif },
      { key: 'DEA', kind: 'line', color: '#4a90e2', values: dea },
      { key: 'HIST', kind: 'histogram', color: '#8a8f99', values: hist, histogramBySign: true },
    ]
  },
})

/** RSI（Wilder 平滑，14）。 */
registerIndicator({
  id: 'rsi',
  pane: 'sub',
  titleKey: 'indicator.rsi',
  params: [{ key: 'n', labelKey: 'indicator.param.period', default: 14, min: 2, max: 120 }],
  compute(bars, params) {
    return [{ key: `RSI${params.n}`, kind: 'line', color: '#c05fd8', values: rsi(closesOf(bars), params.n) }]
  },
})

/** KDJ（RSV 的 1/3 平滑，9）。 */
registerIndicator({
  id: 'kdj',
  pane: 'sub',
  titleKey: 'indicator.kdj',
  params: [{ key: 'n', labelKey: 'indicator.param.period', default: 9, min: 1, max: 120 }],
  compute(bars, params) {
    const highs = bars.map(bar => bar.high)
    const lows = bars.map(bar => bar.low)
    const { k, d, j } = kdj(highs, lows, closesOf(bars), params.n)
    return [
      { key: 'K', kind: 'line', color: '#e6b800', values: k },
      { key: 'D', kind: 'line', color: '#4a90e2', values: d },
      { key: 'J', kind: 'line', color: '#c05fd8', values: j },
    ]
  },
})
