/**
 * 200 日均线择时基线策略（长线，Meb Faber GTAA 经典）。
 *
 * 入场：收盘价站上 SMA200 牛市生命线，全仓持有。
 * 出场：收盘价跌破 SMA200 熊市防线，空仓避险。
 */
import { sma } from '@dshtrading/indicators'
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
    const closes = bars.map((b) => b.close)
    const smaValues = sma(closes, period)
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
