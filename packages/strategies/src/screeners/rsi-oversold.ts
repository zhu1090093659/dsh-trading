/**
 * RSI 超卖：RSI(period) 跌入阈值以下的逆势关注筛选——超卖≠见底，
 * 定位是「值得盯的反转候选池」，命中理由里明示是逆势信号。
 */
import { rsi } from '@dsh-trading/indicators'
import type { ScreenerDefinition } from './types.ts'

export const rsiOversoldScreener: ScreenerDefinition = {
  id: 'scr.rsi-oversold',
  name: 'RSI 超卖',
  summary: 'RSI 跌入超卖区（默认 <30），筛选值得盯的反转候选（逆势信号）',
  params: [
    { key: 'period', label: 'RSI 周期', default: 14, min: 5, max: 30, step: 1 },
    { key: 'threshold', label: '超卖阈值', default: 30, min: 10, max: 50, step: 5 },
  ],
  columns: [
    { key: 'rsi', label: 'RSI' },
  ],
  evaluate(bars, params) {
    const period = Math.max(5, Math.round(params.period ?? 14))
    const threshold = Math.min(50, Math.max(10, params.threshold ?? 30))
    const i = bars.length - 1
    if (i < period) return null

    const value = rsi(bars.map((b) => b.close), period)[i]
    if (value === undefined) return null
    if (!(value < threshold)) return null

    return {
      metrics: { rsi: value },
      reason: `RSI(${period}) = ${value.toFixed(1)}，进入超卖区（逆势信号）`,
      reasonKey: 'scr.rsi-oversold.reason',
      reasonParams: { period, val: value.toFixed(1) },
    }
  },
}
