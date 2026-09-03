/**
 * 12 个月动量择时策略（长线，Fama-French 动量单标的经典化）。
 *
 * 入场：近 12 个月（约 250 根日 K）累计收益 > 0 且价格高于年线，强动量做多。
 * 出场：动量转负或价格跌破年线，动量衰竭离场。
 */
import { sma } from '@dsh-trading/indicators'
import type { StrategyDefinition, StrategySignal } from '../types.ts'

export const momentum12mStrategy: StrategyDefinition = {
  id: 'momentum-12m',
  horizon: 'long',
  name: '12 个月动量择时',
  summary: '近 12 个月动量为正且站上年线做多，动量转负或破位离场（低换手长线动量）',
  params: [
    { key: 'lookbackBars', label: '动量回溯周期 (K线)', default: 250, min: 50, max: 500, step: 10 },
  ],
  compute(bars, params) {
    const lookback = Math.max(10, Math.round(params.lookbackBars ?? 250))
    const closes = bars.map((b) => b.close)
    const smaValues = sma(closes, lookback)
    const signals: StrategySignal[] = []
    let inPosition = false

    for (let i = lookback; i < bars.length; i++) {
      const currentClose = bars[i].close
      const pastClose = bars[i - lookback].close
      const currentSma = smaValues[i]

      if (pastClose <= 0 || currentSma === undefined) continue

      const momentumReturn = (currentClose - pastClose) / pastClose

      if (!inPosition && momentumReturn > 0 && currentClose > currentSma) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'entry',
          direction: 'long',
          price: currentClose,
          reason: `近 ${lookback} 周期动量为正 (+${(momentumReturn * 100).toFixed(1)}%) 且位于均线 (${currentSma.toFixed(2)}) 之上，确认强动量`,
          reasonKey: 'strat.momentum-12m.reason.entry',
          reasonParams: { n: lookback, pct: (momentumReturn * 100).toFixed(1), sma: currentSma.toFixed(2) },
        })
        inPosition = true
      } else if (inPosition && (momentumReturn <= 0 || currentClose < currentSma)) {
        const exitCause = momentumReturn <= 0 ? '动量转为负值' : '跌破基准均线'
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'exit',
          direction: 'flat',
          price: currentClose,
          reason: `${exitCause} (${(momentumReturn * 100).toFixed(1)}% / SMA ${currentSma.toFixed(2)})，动量衰减平仓`,
          reasonKey: 'strat.momentum-12m.reason.exit',
          reasonParams: { cause: momentumReturn <= 0 ? 'momentumNegative' : 'belowBaseline', pct: (momentumReturn * 100).toFixed(1), sma: currentSma.toFixed(2) },
        })
        inPosition = false
      }
    }

    return signals
  },
}
