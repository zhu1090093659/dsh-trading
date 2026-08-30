/**
 * 预置指标（仿富途：主图 MA/EMA/BOLL，副图 MACD/RSI/KDJ）。全部是
 * definition 数据 + math.ts 纯函数的组合，无渲染逻辑；由指标插件
 * （client-ui-indicators）注册进 tradingIndicators 服务。
 */
import type { IndicatorDefinition, Kline } from './types.ts'
import { bollinger, ema, kdj, macd, rsi, sma } from './math.ts'

/** MA 线配色（富途系三色 + 扩展周期轮换调色板）。 */
export const MA_COLORS: Record<string, string> = {
  MA5: '#e6b800',
  MA10: '#4a90e2',
  MA20: '#c05fd8',
}

/** 任意周期均线的取色：命中富途三色用之，否则按周期轮换调色板。 */
const FALLBACK_PALETTE: readonly string[] = ['#e6b800', '#4a90e2', '#c05fd8', '#f97316', '#0ea5e9']

function maColor(period: number): string {
  return MA_COLORS[`MA${period}`] ?? FALLBACK_PALETTE[period % FALLBACK_PALETTE.length] ?? '#8a8f99'
}

const closesOf = (bars: readonly Kline[]): number[] => bars.map(bar => bar.close)

/** 六个预置 definition（纯数据，注册时机归消费方）。 */
/** 六个预置 definition（纯数据，注册时机归消费方）。 */
export function presetDefinitions(): IndicatorDefinition[] {
  return [
    {
      // MA：一组三条均线（周期可调，默认 5/10/20）。
      id: 'ma',
      pane: 'main',
      title: 'MA',
      params: [
        { key: 'n1', label: '周期1', default: 5, min: 1, max: 250 },
        { key: 'n2', label: '周期2', default: 10, min: 1, max: 250 },
        { key: 'n3', label: '周期3', default: 20, min: 1, max: 250 },
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
    },
    {
      // EMA：两条指数均线（12/26，与 MACD 默认周期呼应）。
      id: 'ema',
      pane: 'main',
      title: 'EMA',
      params: [
        { key: 'n1', label: '周期1', default: 12, min: 1, max: 250 },
        { key: 'n2', label: '周期2', default: 26, min: 1, max: 250 },
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
    },
    {
      // BOLL：中轨 + 上下轨（20, ×2）。
      id: 'boll',
      pane: 'main',
      title: 'BOLL',
      params: [
        { key: 'n', label: '周期', default: 20, min: 2, max: 250 },
        { key: 'k', label: '倍数', default: 2, min: 1, max: 5 },
      ],
      compute(bars, params) {
        const { mid, upper, lower } = bollinger(closesOf(bars), params.n, params.k)
        return [
          { key: 'MID', kind: 'line', color: '#8a8f99', values: mid },
          { key: 'UP', kind: 'line', color: '#4a90e2', values: upper },
          { key: 'LOW', kind: 'line', color: '#4a90e2', values: lower },
        ]
      },
    },
    {
      // MACD：DIF/DEA 线 + 按符号红涨绿跌的柱（12,26,9）。
      id: 'macd',
      pane: 'sub',
      title: 'MACD',
      params: [
        { key: 'fast', label: '快线', default: 12, min: 2, max: 100 },
        { key: 'slow', label: '慢线', default: 26, min: 2, max: 200 },
        { key: 'signal', label: '信号', default: 9, min: 1, max: 60 },
      ],
      compute(bars, params) {
        const { dif, dea, hist } = macd(closesOf(bars), params.fast, params.slow, params.signal)
        return [
          { key: 'DIF', kind: 'line', color: '#e6b800', values: dif },
          { key: 'DEA', kind: 'line', color: '#4a90e2', values: dea },
          { key: 'HIST', kind: 'histogram', color: '#8a8f99', values: hist, histogramBySign: true },
        ]
      },
    },
    {
      // RSI（Wilder 平滑，14）。
      id: 'rsi',
      pane: 'sub',
      title: 'RSI',
      params: [{ key: 'n', label: '周期', default: 14, min: 2, max: 120 }],
      compute(bars, params) {
        return [{ key: `RSI${params.n}`, kind: 'line', color: '#c05fd8', values: rsi(closesOf(bars), params.n) }]
      },
    },
    {
      // KDJ（RSV 的 1/3 平滑，9）。
      id: 'kdj',
      pane: 'sub',
      title: 'KDJ',
      params: [{ key: 'n', label: '周期', default: 9, min: 1, max: 120 }],
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
    },
  ]
}

