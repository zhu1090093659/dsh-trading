/**
 * 200 日均线择时基线策略（长线，Meb Faber GTAA 经典）。
 *
 * 入场：收盘价站上 SMA200 牛市生命线，全仓持有。
 * 出场：收盘价跌破 SMA200 熊市防线，空仓避险。
 *
 * compute 自包含（内联滚动 SMA，与 @dshtrading/indicators math.ts 同式）：
 * 策略管理（覆盖内置）可经 compute.toString() 导出完整可编译源码。
 */
import type { StrategyDefinition, StrategySignal } from '../types.ts'

export const smaBaselineStrategy: StrategyDefinition = {
  id: 'sma-baseline',
  horizon: 'long',
  name: '200 日均线牛熊择时基线',
  summary: '收盘价站上 SMA200 均线做多，跌破均线空仓避险（长线资产配置经典基线）',
  params: [
    { key: 'period', label: '长期均线周期', default: 200, min: 50, max: 300, step: 10 },
  ],
  compute(bars, params) {
    const period = Math.max(10, Math.round(params.period ?? 200))

    const smaOf = (values: number[], period: number): Array<number | undefined> => {
      const out: Array<number | undefined> = new Array(values.length).fill(undefined)
      if (!Number.isFinite(period) || period < 1 || values.length < period) return out
      let sum = 0
      for (let index = 0; index < values.length; index++) {
        sum += values[index] as number
        if (index >= period) sum -= values[index - period] as number
        if (index >= period - 1) out[index] = sum / period
      }
      return out
    }

    const closes = bars.map((b) => b.close)
    const smaValues = smaOf(closes, period)
    const signals: StrategySignal[] = []
    let inPosition = false

    for (let i = period - 1; i < bars.length; i++) {
      const currentClose = bars[i].close
      const currentSma = smaValues[i]
      if (currentSma === undefined) continue

      if (!inPosition && currentClose > currentSma) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'entry',
          direction: 'long',
          price: currentClose,
          reason: `收盘价 (${currentClose.toFixed(2)}) 站上长期基线 SMA(${period}) (${currentSma.toFixed(2)})，确立多头趋势`,
          reasonKey: 'strat.sma-baseline.reason.entry',
          reasonParams: { close: currentClose.toFixed(2), period, sma: currentSma.toFixed(2) },
        })
        inPosition = true
      } else if (inPosition && currentClose < currentSma) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'exit',
          direction: 'flat',
          price: currentClose,
          reason: `收盘价 (${currentClose.toFixed(2)}) 跌破长期基线 SMA(${period}) (${currentSma.toFixed(2)})，转入防御避险`,
          reasonKey: 'strat.sma-baseline.reason.exit',
          reasonParams: { close: currentClose.toFixed(2), period, sma: currentSma.toFixed(2) },
        })
        inPosition = false
      }
    }

    return signals
  },
}
