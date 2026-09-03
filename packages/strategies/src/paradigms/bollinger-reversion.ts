/**
 * 布林带下轨均值回归策略（波段）。
 *
 * 入场：收盘价跌破布林线下轨（超卖错杀）。
 * 出场：收盘价回归至布林带中轨（均线目标位平仓）。
 */
import { bollinger } from '@dshtrading/indicators'
import type { StrategyDefinition, StrategySignal } from '../types.ts'

export const bollingerReversionStrategy: StrategyDefinition = {
  id: 'bollinger-reversion',
  horizon: 'swing',
  name: '布林带下轨均值回归',
  summary: '价格跌破布林线下轨时介入抄底，反弹至中轨（基准均线）时平仓（波段通道回归）',
  params: [
    { key: 'period', label: '布林周期', default: 20, min: 5, max: 50, step: 1 },
    { key: 'multiplier', label: '标准差倍数 (k)', default: 2, min: 1, max: 4, step: 0.5 },
  ],
  compute(bars, params) {
    const period = Math.max(5, Math.round(params.period ?? 20))
    const k = Number(params.multiplier ?? 2)

    const closes = bars.map((b) => b.close)
    const { mid, lower } = bollinger(closes, period, k)
    const signals: StrategySignal[] = []
    let inPosition = false

    for (let i = period - 1; i < bars.length; i++) {
      const currentClose = bars[i].close
      const currentLower = lower[i]
      const currentMid = mid[i]

      if (currentLower === undefined || currentMid === undefined) continue

      if (!inPosition && currentClose < currentLower) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'entry',
          direction: 'long',
          price: currentClose,
          reason: `收盘价 (${currentClose.toFixed(2)}) 跌破布林下轨 (${currentLower.toFixed(2)})，触发波段均值回归`,
          reasonKey: 'strat.bollinger-reversion.reason.entry',
          reasonParams: { close: currentClose.toFixed(2), band: currentLower.toFixed(2) },
        })
        inPosition = true
      } else if (inPosition && currentClose >= currentMid) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'exit',
          direction: 'flat',
          price: currentClose,
          reason: `收盘价 (${currentClose.toFixed(2)}) 成功回归至布林中轨 (${currentMid.toFixed(2)})，完成目标止盈`,
          reasonKey: 'strat.bollinger-reversion.reason.exit',
          reasonParams: { close: currentClose.toFixed(2), mid: currentMid.toFixed(2) },
        })
        inPosition = false
      }
    }

    return signals
  },
}
