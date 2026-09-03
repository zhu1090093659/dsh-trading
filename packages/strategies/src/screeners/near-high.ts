/**
 * 接近一年新高：现价距窗口最高价不超过 withinPct%——动量/突破前夜筛选。
 * 要求完整窗口数据（不足一年的标的直接跳过，避免把「上市不久」误判成「接近新高」）。
 */
import type { ScreenerDefinition } from './types.ts'

export const nearHighScreener: ScreenerDefinition = {
  id: 'scr.near-high',
  name: '接近一年新高',
  summary: '现价距 N 日最高价不超过 X%，强势整理/突破前夜的动量筛选',
  params: [
    { key: 'window', label: '窗口(日)', default: 250, min: 60, max: 500, step: 10 },
    { key: 'withinPct', label: '接近阈值(%)', default: 5, min: 1, max: 30, step: 1 },
  ],
  columns: [
    { key: 'offHighPct', label: '距高点', format: 'percent' },
  ],
  evaluate(bars, params) {
    const window = Math.max(60, Math.round(params.window ?? 250))
    const withinPct = Math.max(1, params.withinPct ?? 5)
    const i = bars.length - 1
    if (i + 1 < window) return null

    const windowBars = bars.slice(i + 1 - window)
    const highMax = Math.max(...windowBars.map((b) => b.high))
    if (!(highMax > 0)) return null

    const close = bars[i]!.close
    const offHighPct = ((highMax - close) / highMax) * 100
    if (!(offHighPct >= 0 && offHighPct <= withinPct)) return null

    return {
      metrics: { offHighPct },
      reason: `距 ${window} 日高点仅 ${offHighPct.toFixed(2)}%，处于突破前夜`,
    }
  },
}
