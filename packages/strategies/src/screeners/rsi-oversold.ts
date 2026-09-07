/**
 * RSI 超卖：RSI(period) 跌入阈值以下的逆势关注筛选——超卖≠见底，
 * 定位是「值得盯的反转候选池」，命中理由里明示是逆势信号。
 *
 * evaluate 自包含（内联 Wilder RSI，与 @dshtrading/indicators math.ts 同式）：
 * 选股器管理（覆盖内置）可经 evaluate.toString() 导出完整可编译源码。
 */
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

    const rsiOf = (values: number[], period: number): Array<number | undefined> => {
      const out: Array<number | undefined> = new Array(values.length).fill(undefined)
      if (!Number.isFinite(period) || period < 1 || values.length < period) return out
      let gain = 0
      let loss = 0
      for (let index = 1; index <= period; index++) {
        const delta = (values[index] as number) - (values[index - 1] as number)
        if (delta >= 0) gain += delta
        else loss -= delta
      }
      gain /= period
      loss /= period
      out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
      for (let index = period + 1; index < values.length; index++) {
        const delta = (values[index] as number) - (values[index - 1] as number)
        gain = (gain * (period - 1) + Math.max(delta, 0)) / period
        loss = (loss * (period - 1) + Math.max(-delta, 0)) / period
        out[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
      }
      return out
    }

    const value = rsiOf(bars.map((b) => b.close), period)[i]
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
