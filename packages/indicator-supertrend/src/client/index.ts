/**
 * 超级趋势（社区指标示例/spike，client 半）：证明第三方指标插件可以只经
 * tradingIndicators 服务接入——本包不依赖 @dsh-trading/indicators 的运行时
 * （ATR 本地实现，类型 type-only import），不注册任何 slot，与行情壳零耦合。
 *
 * 接入方式 = ctx.inject(['tradingIndicators'], …)（服务可用时回调才触发；
 * cordis 依赖解析保证晚于提供方 provide）→ register(definition) 上榜。
  *
 * i18n-allow: 独立示例插件，指标标题/参数文案本期不进词典（与预置指标中文 title 同口径）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IndicatorDefinition, Kline, Series } from '@dsh-trading/indicators'

/** Wilder 平滑 ATR（本地实现：社区指标自带数学内核的形态）。 */
function atr(highs: readonly number[], lows: readonly number[], closes: readonly number[], period: number): Series {
  const n = closes.length
  const out: Array<number | undefined> = new Array(n).fill(undefined)
  if (!Number.isFinite(period) || period < 1 || n <= period) return out
  const tr: number[] = [highs[0]! - lows[0]!]
  for (let index = 1; index < n; index++) {
    tr.push(Math.max(
      highs[index]! - lows[index]!,
      Math.abs(highs[index]! - closes[index - 1]!),
      Math.abs(lows[index]! - closes[index - 1]!),
    ))
  }
  let prev = 0
  for (let index = 0; index < period; index++) prev += tr[index]!
  prev /= period
  out[period] = prev
  for (let index = period + 1; index < n; index++) {
    prev = (prev * (period - 1) + tr[index]!) / period
    out[index] = prev
  }
  return out
}

/** 超级趋势 definition：多空分段双色 Area 趋势带（上升趋势多头绿带 + 向上淡绿阴影，下降趋势空头红带 + 向下淡红阴影）。 */
export function supertrendDefinition(): IndicatorDefinition {
  return {
    id: 'supertrend',
    pane: 'main',
    title: '超级趋势',
    params: [
      { key: 'period', label: '周期', default: 10, min: 2, max: 100 },
      { key: 'mult', label: '倍数', default: 3, min: 1, max: 10 },
    ],
    compute(bars: readonly Kline[], params: Readonly<Record<string, number>>) {
      const n = bars.length
      const highs = bars.map(bar => bar.high)
      const lows = bars.map(bar => bar.low)
      const closes = bars.map(bar => bar.close)
      const atrSeries = atr(highs, lows, closes, params.period)
      const upValues: Array<number | undefined> = new Array(n).fill(undefined)
      const downValues: Array<number | undefined> = new Array(n).fill(undefined)
      let trend = 1
      let finalUpper = 0
      let finalLower = 0
      let started = false
      for (let index = 0; index < n; index++) {
        const av = atrSeries[index]
        if (av === undefined) continue
        const mid = (highs[index]! + lows[index]!) / 2
        const upper = mid + params.mult * av
        const lower = mid - params.mult * av
        if (!started) {
          finalUpper = upper
          finalLower = lower
          started = true
          trend = 1
          upValues[index] = finalLower
          continue
        }
        // band 收敛规则：新带更紧或趋势未破旧带时沿用新/旧带（标准 SuperTrend）。
        finalUpper = (upper < finalUpper || closes[index - 1]! > finalUpper) ? upper : finalUpper
        finalLower = (lower > finalLower || closes[index - 1]! < finalLower) ? lower : finalLower
        if (trend === 1 && closes[index]! < finalLower) trend = -1
        else if (trend === -1 && closes[index]! > finalUpper) trend = 1

        if (trend === 1) {
          upValues[index] = finalLower
        } else {
          downValues[index] = finalUpper
        }
      }
      return [
        {
          key: 'UP',
          kind: 'area' as const,
          color: '#2ba471',
          topColor: 'rgba(43, 164, 113, 0.00)',
          bottomColor: 'rgba(43, 164, 113, 0.18)',
          invertFilledArea: true,
          lineWidth: 1.5,
          values: upValues,
        },
        {
          key: 'DN',
          kind: 'area' as const,
          color: '#e64545',
          topColor: 'rgba(230, 69, 69, 0.18)',
          bottomColor: 'rgba(230, 69, 69, 0.00)',
          invertFilledArea: false,
          lineWidth: 1.5,
          values: downValues,
        },
      ]
    },
  }
}

export function apply(ctx: Context): void {
  ctx.inject(['tradingIndicators'] as never, (scope) => {
    const service = (scope as unknown as {
      tradingIndicators: { register(definition: IndicatorDefinition): void }
    }).tradingIndicators
    service.register(supertrendDefinition())
    console.info('[indicator-supertrend] registered via tradingIndicators service')
  })
}
