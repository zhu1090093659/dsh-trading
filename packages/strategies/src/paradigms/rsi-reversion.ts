/**
 * 短周期 RSI 极值均值回归策略（短线，Connors 式）。
 *
 * 入场：RSI(2) < 10 极端超卖入场。
 * 出场：RSI(2) > 60 快速反弹获利了结。
 */
import { rsi } from '@dsh-trading/indicators'
import type { StrategyDefinition, StrategySignal } from '../types.ts'

export const rsiReversionStrategy: StrategyDefinition = {
  id: 'rsi-reversion',
  horizon: 'short',
  name: 'RSI 短线极值回归',
  summary: '短周期 RSI(2) 进入极端超卖区抄底，快速反弹后止盈（经典均值回归）',
  params: [
    { key: 'rsiPeriod', label: 'RSI 周期', default: 2, min: 2, max: 14, step: 1 },
    { key: 'entryThreshold', label: '入场超卖阈值', default: 10, min: 1, max: 30, step: 1 },
    { key: 'exitThreshold', label: '出场止盈阈值', default: 60, min: 50, max: 95, step: 1 },
  ],
  compute(bars, params) {
    const period = Math.max(2, Math.round(params.rsiPeriod ?? 2))
    const enterThresh = Number(params.entryThreshold ?? 10)
    const exitThresh = Number(params.exitThreshold ?? 60)

    const closes = bars.map((b) => b.close)
    const rsiValues = rsi(closes, period)
    const signals: StrategySignal[] = []
    let inPosition = false

    for (let i = 0; i < bars.length; i++) {
      const val = rsiValues[i]
      if (val === undefined || Number.isNaN(val)) continue

      if (!inPosition && val < enterThresh) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'entry',
          direction: 'long',
          price: bars[i].close,
          reason: `RSI(${period}) 达到极端超卖值 (${val.toFixed(1)} < ${enterThresh})，触发反弹买入`,
        })
        inPosition = true
      } else if (inPosition && val > exitThresh) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'exit',
          direction: 'flat',
          price: bars[i].close,
          reason: `RSI(${period}) 回升至目标位 (${val.toFixed(1)} > ${exitThresh})，止盈离场`,
        })
        inPosition = false
      }
    }

    return signals
  },
}
