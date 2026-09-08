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

    // 价格文案小数位自适应（与 ../price-format.ts 同式；compute 需自包含）：
    // ≥1 默认 2 位，2 位舍入丢第 3 位有效小数时升 3 位
    const fmtPrice = (value: number): string => {
      if (!Number.isFinite(value)) return '—'
      const abs = Math.abs(value)
      if (abs < 1) return value.toFixed(abs >= 0.01 ? 4 : 6)
      return value.toFixed(Math.abs(Number(value.toFixed(2)) - value) < 1e-9 ? 2 : 3)
    }

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
          reason: `收盘价 (${fmtPrice(currentClose)}) 站上长期基线 SMA(${period}) (${fmtPrice(currentSma)})，确立多头趋势`,
          reasonKey: 'strat.sma-baseline.reason.entry',
          reasonParams: { close: fmtPrice(currentClose), period, sma: fmtPrice(currentSma) },
        })
        inPosition = true
      } else if (inPosition && currentClose < currentSma) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'exit',
          direction: 'flat',
          price: currentClose,
          reason: `收盘价 (${fmtPrice(currentClose)}) 跌破长期基线 SMA(${period}) (${fmtPrice(currentSma)})，转入防御避险`,
          reasonKey: 'strat.sma-baseline.reason.exit',
          reasonParams: { close: fmtPrice(currentClose), period, sma: fmtPrice(currentSma) },
        })
        inPosition = false
      }
    }

    return signals
  },
}
