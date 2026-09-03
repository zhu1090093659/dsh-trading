/**
 * 放量突破：收盘价创 lookback 日新高，且成交量 ≥ 均量的 volMultiple 倍——
 * 突破有效性的量能确认（无量突破不入选）。量比口径跨市场可比（比值无量纲）。
 */
import { sma } from '@dsh-trading/indicators'
import type { ScreenerDefinition } from './types.ts'

export const volumeBreakoutScreener: ScreenerDefinition = {
  id: 'scr.volume-breakout',
  name: '放量突破',
  summary: '收盘价创 N 日新高且成交量 ≥ 均量 M 倍，量价配合的突破筛选',
  params: [
    { key: 'lookback', label: '突破窗口(日)', default: 20, min: 5, max: 60, step: 5 },
    { key: 'volMultiple', label: '量能倍数', default: 2, min: 1, max: 10, step: 0.5 },
  ],
  columns: [
    { key: 'volRatio', label: '量比(倍)' },
    { key: 'breakoutPct', label: '突破幅度', format: 'percent' },
  ],
  evaluate(bars, params) {
    const lookback = Math.max(5, Math.round(params.lookback ?? 20))
    const volMultiple = Math.max(1, params.volMultiple ?? 2)
    const i = bars.length - 1
    // 需要 lookback 根历史 K 线 + 均量窗口
    if (i < lookback) return null

    const window = bars.slice(i - lookback, i)
    const priorHigh = Math.max(...window.map((b) => b.high))
    const volumes = bars.map((b) => b.volume)
    const avgVolume = sma(volumes, lookback)[i]
    if (avgVolume === undefined || avgVolume <= 0) return null

    const close = bars[i].close
    const volume = bars[i].volume
    if (!(close > priorHigh) || !(volume >= volMultiple * avgVolume)) return null

    const volRatio = volume / avgVolume
    const breakoutPct = ((close - priorHigh) / priorHigh) * 100
    return {
      metrics: { volRatio, breakoutPct },
      reason: `放量 ${volRatio.toFixed(2)} 倍突破 ${lookback} 日高点`,
    }
  },
}
