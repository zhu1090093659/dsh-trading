/**
 * 预置指标（仿富途：主图 MA/EMA/BOLL，副图 MACD/RSI/KDJ）。全部是
 * definition 数据 + math.ts 纯函数的组合，无渲染逻辑；由指标插件
 * （client-ui-indicators）注册进 tradingIndicators 服务。
 */
import type { IndicatorDefinition, Kline } from './types.ts'
import { bollinger, ema, kdj, macd, rsi, sma } from './math.ts'

/** MA 线配色（富途系配色 + 扩展周期轮换调色板）。 */
export const MA_COLORS: Record<string, string> = {
  MA5: '#e6b800',
  MA10: '#4a90e2',
  MA20: '#c05fd8',
  MA30: '#2ba471',
  MA60: '#f97316',
  MA120: '#0ea5e9',
  MA250: '#8a8f99',
}

/** EMA 线配色。 */
export const EMA_COLORS: Record<string, string> = {
  EMA5: '#e6b800',
  EMA6: '#e6b800',
  EMA10: '#4a90e2',
  EMA12: '#ff9800',
  EMA20: '#c05fd8',
  EMA26: '#00bcd4',
  EMA30: '#2ba471',
  EMA50: '#2ba471',
  EMA60: '#f97316',
  EMA120: '#0ea5e9',
  EMA200: '#8a8f99',
  EMA250: '#8a8f99',
}

/** 均线 6 色备用调色板（富途黄/蓝/紫/绿/橙/青）。 */
const FALLBACK_PALETTE: readonly string[] = ['#e6b800', '#4a90e2', '#c05fd8', '#2ba471', '#f97316', '#0ea5e9']

function maColor(period: number, index: number): string {
  return MA_COLORS[`MA${period}`] ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] ?? '#8a8f99'
}

function emaColor(period: number, index: number): string {
  return EMA_COLORS[`EMA${period}`] ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] ?? '#8a8f99'
}

const closesOf = (bars: readonly Kline[]): number[] => bars.map(bar => bar.close)

/** 六个预置 definition（纯数据，注册时机归消费方）。 */
export function presetDefinitions(): IndicatorDefinition[] {
  return [
    {
      // MA：一组最多 6 条均线（周期可调，默认 5/10/20/30/60/120，0 表示隐藏）。
      id: 'ma',
      pane: 'main',
      title: 'MA',
      params: [
        { key: 'n1', label: '周期1', default: 5, min: 0, max: 250 },
        { key: 'n2', label: '周期2', default: 10, min: 0, max: 250 },
        { key: 'n3', label: '周期3', default: 20, min: 0, max: 250 },
        { key: 'n4', label: '周期4', default: 30, min: 0, max: 250 },
        { key: 'n5', label: '周期5', default: 60, min: 0, max: 250 },
        { key: 'n6', label: '周期6', default: 120, min: 0, max: 250 },
      ],
      compute(bars, params) {
        const closes = closesOf(bars)
        const periods = [params.n1, params.n2, params.n3, params.n4, params.n5, params.n6]
          .filter((period): period is number => typeof period === 'number' && Number.isFinite(period) && period > 0)
        return periods.map((period, index) => ({
          key: `MA${period}`,
          kind: 'line' as const,
          color: maColor(period, index),
          values: sma(closes, period),
        }))
      },
    },
    {
      // EMA：一组最多 6 条指数均线（周期可调，默认 5/10/20/30/60/120，0 表示隐藏）。
      id: 'ema',
      pane: 'main',
      title: 'EMA',
      params: [
        { key: 'n1', label: '周期1', default: 5, min: 0, max: 250 },
        { key: 'n2', label: '周期2', default: 10, min: 0, max: 250 },
        { key: 'n3', label: '周期3', default: 20, min: 0, max: 250 },
        { key: 'n4', label: '周期4', default: 30, min: 0, max: 250 },
        { key: 'n5', label: '周期5', default: 60, min: 0, max: 250 },
        { key: 'n6', label: '周期6', default: 120, min: 0, max: 250 },
      ],
      compute(bars, params) {
        const closes = closesOf(bars)
        const periods = [params.n1, params.n2, params.n3, params.n4, params.n5, params.n6]
          .filter((period): period is number => typeof period === 'number' && Number.isFinite(period) && period > 0)
        return periods.map((period, index) => ({
          key: `EMA${period}`,
          kind: 'line' as const,
          color: emaColor(period, index),
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

