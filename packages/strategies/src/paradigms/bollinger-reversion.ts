/**
 * 布林带下轨均值回归策略（波段）。
 *
 * 入场：收盘价跌破布林线下轨（超卖错杀）。
 * 出场：收盘价回归至布林带中轨（均线目标位平仓）。
 *
 * compute 自包含（内联 SMA + 总体口径滚动标准差合成的布林带，
 * 与 @dshtrading/indicators math.ts 同式）：策略管理（覆盖内置）可经
 * compute.toString() 导出完整可编译源码。
 */
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
    const stdevOf = (values: number[], period: number): Array<number | undefined> => {
      const out: Array<number | undefined> = new Array(values.length).fill(undefined)
      if (!Number.isFinite(period) || period < 1 || values.length < period) return out
      for (let index = period - 1; index < values.length; index++) {
        let mean = 0
        for (let offset = 0; offset < period; offset++) mean += values[index - offset] as number
        mean /= period
        let variance = 0
        for (let offset = 0; offset < period; offset++) {
          const delta = (values[index - offset] as number) - mean
          variance += delta * delta
        }
        out[index] = Math.sqrt(variance / period)
      }
      return out
    }

    const closes = bars.map((b) => b.close)
    const mid = smaOf(closes, period)
    const sd = stdevOf(closes, period)
    const lower: Array<number | undefined> = closes.map((_, index) => {
      const base = mid[index]
      const dev = sd[index]
      return base === undefined || dev === undefined ? undefined : base - k * dev
    })
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
          reason: `收盘价 (${fmtPrice(currentClose)}) 跌破布林下轨 (${fmtPrice(currentLower)})，触发波段均值回归`,
          reasonKey: 'strat.bollinger-reversion.reason.entry',
          reasonParams: { close: fmtPrice(currentClose), band: fmtPrice(currentLower) },
        })
        inPosition = true
      } else if (inPosition && currentClose >= currentMid) {
        signals.push({
          index: i,
          time: bars[i].openTime,
          action: 'exit',
          direction: 'flat',
          price: currentClose,
          reason: `收盘价 (${fmtPrice(currentClose)}) 成功回归至布林中轨 (${fmtPrice(currentMid)})，完成目标止盈`,
          reasonKey: 'strat.bollinger-reversion.reason.exit',
          reasonParams: { close: fmtPrice(currentClose), mid: fmtPrice(currentMid) },
        })
        inPosition = false
      }
    }

    return signals
  },
}
