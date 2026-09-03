/**
 * 唐奇安通道突破策略（短线，海龟简化版）。
 *
 * 入场：收盘价突破前 N1 根 K 线的最高价（突破追多）。
 * 出场：收盘价跌破前 N2 根 K 线的最低价（保护性离场）。
 */
import type { StrategyDefinition, StrategySignal } from '../types.ts'

export const donchianBreakoutStrategy: StrategyDefinition = {
  id: 'donchian-breakout',
  horizon: 'short',
  name: '唐奇安通道突破',
  summary: '收盘价突破前 N1 根最高价做多，跌破前 N2 根最低价离场（海龟经典简化版）',
  params: [
    { key: 'lookbackEntry', label: '突破周期 (N1)', default: 20, min: 5, max: 100, step: 1 },
    { key: 'lookbackExit', label: '离场周期 (N2)', default: 10, min: 2, max: 50, step: 1 },
  ],
  compute(bars, params) {
    const n1 = Math.max(2, Math.round(params.lookbackEntry ?? 20))
    const n2 = Math.max(1, Math.round(params.lookbackExit ?? 10))
    const signals: StrategySignal[] = []
    let inPosition = false

    for (let i = Math.max(n1, n2); i < bars.length; i++) {
      const currentClose = bars[i].close

      // 1. 计算前 n1 根最高价
      let highestHigh = -Infinity
      for (let j = i - n1; j < i; j++) {
        if (bars[j].high > highestHigh) highestHigh = bars[j].high
      }

      // 2. 计算前 n2 根最低价
      let lowestLow = Infinity
      for (let j = i - n2; j < i; j++) {
        if (bars[j].low < lowestLow) lowestLow = bars[j].low
      }

      if (!inPosition && currentClose > highestHigh) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'entry',
          direction: 'long',
          price: currentClose,
          reason: `收盘价 (${currentClose.toFixed(2)}) 突破前 ${n1} 根最高价 (${highestHigh.toFixed(2)})`,
          reasonKey: 'strat.donchian-breakout.reason.entry',
          reasonParams: { close: currentClose.toFixed(2), n: n1, high: highestHigh.toFixed(2) },
        })
        inPosition = true
      } else if (inPosition && currentClose < lowestLow) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'exit',
          direction: 'flat',
          price: currentClose,
          reason: `收盘价 (${currentClose.toFixed(2)}) 跌破前 ${n2} 根最低价 (${lowestLow.toFixed(2)})`,
          reasonKey: 'strat.donchian-breakout.reason.exit',
          reasonParams: { close: currentClose.toFixed(2), n: n2, low: lowestLow.toFixed(2) },
        })
        inPosition = false
      }
    }

    return signals
  },
}
