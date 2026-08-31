/**
 * 双均线趋势跟踪策略（波段）。
 *
 * 入场：EMA(fast) 上穿 EMA(slow) 金叉做多。
 * 出场：EMA(fast) 下穿 EMA(slow) 死叉离场。
 */
import { ema } from '@dsh-trading/indicators'
import type { StrategyDefinition, StrategySignal } from '../types.ts'

export const emaCrossoverStrategy: StrategyDefinition = {
  id: 'ema-crossover',
  horizon: 'swing',
  name: 'EMA 双均线趋势跟踪',
  summary: '快线 EMA 上穿慢线 EMA 金叉做多，死叉平仓（经典中线波段趋势策略）',
  params: [
    { key: 'fastPeriod', label: '快线周期 (Fast)', default: 20, min: 5, max: 50, step: 1 },
    { key: 'slowPeriod', label: '慢线周期 (Slow)', default: 60, min: 20, max: 200, step: 1 },
  ],
  compute(bars, params) {
    const fastP = Math.max(2, Math.round(params.fastPeriod ?? 20))
    const slowP = Math.max(fastP + 1, Math.round(params.slowPeriod ?? 60))

    const closes = bars.map((b) => b.close)
    const fastEma = ema(closes, fastP)
    const slowEma = ema(closes, slowP)
    const signals: StrategySignal[] = []
    let inPosition = false

    for (let i = 1; i < bars.length; i++) {
      const prevFast = fastEma[i - 1]
      const prevSlow = slowEma[i - 1]
      const currFast = fastEma[i]
      const currSlow = slowEma[i]

      if (
        prevFast === undefined
        || prevSlow === undefined
        || currFast === undefined
        || currSlow === undefined
      ) {
        continue
      }

      // 金叉判断
      if (!inPosition && prevFast <= prevSlow && currFast > currSlow) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'entry',
          direction: 'long',
          price: bars[i].close,
          reason: `EMA(${fastP}) (${currFast.toFixed(2)}) 上穿 EMA(${slowP}) (${currSlow.toFixed(2)}) 形成金叉`,
        })
        inPosition = true
      }
      // 死叉判断
      else if (inPosition && prevFast >= prevSlow && currFast < currSlow) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'exit',
          direction: 'flat',
          price: bars[i].close,
          reason: `EMA(${fastP}) (${currFast.toFixed(2)}) 下穿 EMA(${slowP}) (${currSlow.toFixed(2)}) 形成死叉`,
        })
        inPosition = false
      }
    }

    return signals
  },
}
