/**
 * 双均线趋势跟踪策略（波段）。
 *
 * 入场：EMA(fast) 上穿 EMA(slow) 金叉做多。
 * 出场：EMA(fast) 下穿 EMA(slow) 死叉离场。
 *
 * compute 自包含（内联标准 EMA，与 @dshtrading/indicators math.ts 同式）：
 * 策略管理（覆盖内置）可经 compute.toString() 导出完整可编译源码。
 */
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

    const emaOf = (values: number[], period: number): Array<number | undefined> => {
      const out: Array<number | undefined> = new Array(values.length).fill(undefined)
      if (!Number.isFinite(period) || period < 1 || values.length < period) return out
      const k = 2 / (period + 1)
      let seed = 0
      for (let index = 0; index < period; index++) seed += values[index] as number
      let prev = seed / period
      out[period - 1] = prev
      for (let index = period; index < values.length; index++) {
        prev = (values[index] as number) * k + prev * (1 - k)
        out[index] = prev
      }
      return out
    }

    const closes = bars.map((b) => b.close)
    const fastEma = emaOf(closes, fastP)
    const slowEma = emaOf(closes, slowP)
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
          reasonKey: 'strat.ema-crossover.reason.entry',
          reasonParams: { fastP, fast: currFast.toFixed(2), slowP, slow: currSlow.toFixed(2) },
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
          reasonKey: 'strat.ema-crossover.reason.exit',
          reasonParams: { fastP, fast: currFast.toFixed(2), slowP, slow: currSlow.toFixed(2) },
        })
        inPosition = false
      }
    }

    return signals
  },
}
