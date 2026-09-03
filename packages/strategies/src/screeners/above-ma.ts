/**
 * 牛熊线之上：现价站上长期均线且均线自身斜率向上——与量化「200 日均线
 * 牛熊择时基线」同源的长线标的筛选（Faber GTAA 的截面版）。
 */
import { sma } from '@dsh-trading/indicators'
import type { ScreenerDefinition } from './types.ts'

export const aboveMaScreener: ScreenerDefinition = {
  id: 'scr.above-ma',
  name: '站上牛熊线',
  summary: '现价站上长期均线且均线斜率向上，筛选长线多头环境的标的',
  params: [
    { key: 'period', label: '牛熊线周期', default: 200, min: 50, max: 300, step: 10 },
    { key: 'slopeBars', label: '斜率窗口(日)', default: 20, min: 5, max: 60, step: 5 },
  ],
  columns: [
    { key: 'aboveMaPct', label: '高于均线', format: 'percent' },
    { key: 'maSlopePct', label: '均线斜率', format: 'percent' },
  ],
  evaluate(bars, params) {
    const period = Math.max(50, Math.round(params.period ?? 200))
    const slopeBars = Math.max(5, Math.round(params.slopeBars ?? 20))
    const i = bars.length - 1
    if (i < period + slopeBars - 1) return null

    const closes = bars.map((b) => b.close)
    const maSeries = sma(closes, period)
    const ma = maSeries[i]
    const maPrev = maSeries[i - slopeBars]
    if (ma === undefined || maPrev === undefined || !(maPrev > 0)) return null

    const close = bars[i]!.close
    if (!(close > ma) || !(ma > maPrev)) return null

    const aboveMaPct = ((close - ma) / ma) * 100
    const maSlopePct = ((ma - maPrev) / maPrev) * 100
    return {
      metrics: { aboveMaPct, maSlopePct },
      reason: `现价高于 SMA(${period}) ${aboveMaPct.toFixed(2)}%，均线 ${slopeBars} 日斜率 +${maSlopePct.toFixed(2)}%`,
    }
  },
}
