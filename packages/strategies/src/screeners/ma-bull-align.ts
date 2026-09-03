/**
 * 均线多头排列：现价站上三线，且短中期均线自上而下依次压制
 * （SMA(短) > SMA(中) > SMA(长)），趋势结构完整的顺势筛选。
 */
import { sma } from '@dsh-trading/indicators'
import type { ScreenerDefinition, ScreenerMatch } from './types.ts'

export const maBullAlignScreener: ScreenerDefinition = {
  id: 'scr.ma-bull-align',
  name: '均线多头排列',
  summary: '现价站上三线且 SMA(短) > SMA(中) > SMA(长)，筛选趋势结构完整的标的',
  params: [
    { key: 'n1', label: '短期均线', default: 20, min: 5, max: 120, step: 5 },
    { key: 'n2', label: '中期均线', default: 60, min: 20, max: 250, step: 10 },
    { key: 'n3', label: '长期均线', default: 120, min: 50, max: 300, step: 10 },
  ],
  columns: [
    { key: 'distLongPct', label: '距长期均线', format: 'percent' },
  ],
  evaluate(bars, params) {
    const n1 = Math.max(5, Math.round(params.n1 ?? 20))
    const n2 = Math.max(n1, Math.round(params.n2 ?? 60))
    const n3 = Math.max(n2, Math.round(params.n3 ?? 120))
    const i = bars.length - 1
    if (i + 1 < n3) return null

    const closes = bars.map((b) => b.close)
    const s1 = sma(closes, n1)[i]
    const s2 = sma(closes, n2)[i]
    const s3 = sma(closes, n3)[i]
    if (s1 === undefined || s2 === undefined || s3 === undefined) return null

    const close = bars[i].close
    if (!(close > s1 && s1 > s2 && s2 > s3)) return null

    const distLongPct = ((close - s3) / s3) * 100
    return {
      metrics: { distLongPct },
      reason: `现价站上三线且 SMA(${n1}) > SMA(${n2}) > SMA(${n3})，多头排列`,
    }
  },
}
