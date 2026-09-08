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

    // 价格文案小数位自适应（与 ../price-format.ts 同式；compute 需自包含）：
    // ≥1 默认 2 位，2 位舍入丢第 3 位有效小数时升 3 位
    const fmtPrice = (value: number): string => {
      if (!Number.isFinite(value)) return '—'
      const abs = Math.abs(value)
      if (abs < 1) return value.toFixed(abs >= 0.01 ? 4 : 6)
      return value.toFixed(Math.abs(Number(value.toFixed(2)) - value) < 1e-9 ? 2 : 3)
    }
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
          reason: `收盘价 (${fmtPrice(currentClose)}) 突破前 ${n1} 根最高价 (${fmtPrice(highestHigh)})`,
          reasonKey: 'strat.donchian-breakout.reason.entry',
          reasonParams: { close: fmtPrice(currentClose), n: n1, high: fmtPrice(highestHigh) },
        })
        inPosition = true
      } else if (inPosition && currentClose < lowestLow) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'exit',
          direction: 'flat',
          price: currentClose,
          reason: `收盘价 (${fmtPrice(currentClose)}) 跌破前 ${n2} 根最低价 (${fmtPrice(lowestLow)})`,
          reasonKey: 'strat.donchian-breakout.reason.exit',
          reasonParams: { close: fmtPrice(currentClose), n: n2, low: fmtPrice(lowestLow) },
        })
        inPosition = false
      }
    }

    return signals
  },
}
