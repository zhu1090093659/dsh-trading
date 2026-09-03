/**
 * reasonKey ↔ 词典契约测试（PR #56 评审 L6）：
 * 引擎/选股器发出的每个 reasonKey 必须存在于 zh/en 词典，且 reasonParams
 * 的键覆盖词典模板的 {placeholder}——这条不变量此前无测试钉住，违反时 UI
 * 静默回退 zh 单语（en 下 agent/用户看到中文），无任何报错。
 *
 * 附：StrategyView 查表 miss 回退 helper 与 momentum {cause} 枚举预翻译单测。
 */
import { describe, expect, it } from 'vitest'
import { run, strategyParadigms, screenerParadigms } from '@dsh-trading/strategies'
import type { Kline } from '@dsh-trading/strategies'
import { zh, en } from '../src/client/locales.ts'
import type { StrategyLocaleKey } from '../src/client/contract.ts'
import { strategyName, exitReasonText } from '../src/client/StrategyView.tsx'
import { screenerName } from '../src/client/strategy-locale.ts'

/** 占位符提取（与 SDK 插值器 /\{(\w+)\}/g 同口径）。 */
function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map(m => m[1])
}

function build(fn: (i: number) => number, n: number): Kline[] {
  const bars: Kline[] = []
  for (let i = 0; i < n; i++) {
    const close = fn(i)
    bars.push({ openTime: 86_400_000 * i, open: close * 0.995, high: close * 1.01, low: close * 0.99, close, volume: 1000 + (i % 5) * 400 })
  }
  return bars
}

/** 锯齿行情：触发短线/波段范式（突破、RSI、交叉、布林）。 */
const sawtooth = build(i => 100 + 30 * Math.sin(i / 8) + i * 0.1, 200)
/** 长趋势 + 回落：触发长线范式（sma-baseline / momentum-12m，需 ~250 根回溯）。 */
const longTrend = build(i => i < 300 ? 100 * Math.pow(1.003, i) : 100 * Math.pow(1.003, 300) * Math.pow(0.998, i - 300), 500)

describe('reasonKey ↔ 词典契约（内置范式 + 选股器）', () => {
  it('全部范式策略发出的 reasonKey/exitReasonKey 在 zh+en 词典且占位符被覆盖', () => {
    const checked = new Set<string>()
    for (const strategy of strategyParadigms) {
      const keyed = [
        ...run(sawtooth, strategy).signals,
        ...run(longTrend, strategy).signals,
      ].filter(s => s.reasonKey !== undefined)
      // 双 fixture 合并后每个范式至少发出一个带键信号（缺键即本测试红——
      // 新范式接入时若 fixture 不触发，会以 0 断言失败提醒补 fixture）。
      expect(keyed.length, `${strategy.id} emitted no keyed signals`).toBeGreaterThan(0)
      for (const signal of keyed) {
        const key = signal.reasonKey as StrategyLocaleKey
        checked.add(`${strategy.id}:${key}`)
        for (const dict of [zh, en]) {
          expect(dict, `${strategy.id} key ${key} missing in dict`).toHaveProperty(key)
          for (const ph of placeholdersOf(dict[key])) {
            expect(signal.reasonParams, `${strategy.id} key ${key} placeholder {${ph}} uncovered`).toHaveProperty(ph)
          }
        }
      }
    }
    // momentum 的 {cause} 枚举预翻译路径也有专属键位
    expect(zh).toHaveProperty('strat.momentum-12m.cause.momentumNegative')
    expect(zh).toHaveProperty('strat.momentum-12m.cause.belowBaseline')
    expect(checked.size).toBeGreaterThanOrEqual(strategyParadigms.length)
  })

  it('全部选股器命中结果的 reasonKey 同样对齐', () => {
    for (const screener of screenerParadigms) {
      const defaults = Object.fromEntries(screener.params.map(p => [p.key, p.default]))
      const match = screener.evaluate(sawtooth, defaults)
      if (match === null || match.reasonKey === undefined) continue
      const key = match.reasonKey as StrategyLocaleKey
      for (const dict of [zh, en]) {
        expect(dict, `${screener.id} key ${key} missing in dict`).toHaveProperty(key)
        for (const ph of placeholdersOf(dict[key])) {
          expect(match.reasonParams, `${screener.id} key ${key} placeholder {${ph}} uncovered`).toHaveProperty(ph)
        }
      }
    }
  })
})

/** 查表 miss 回退：t miss 返回 key 本身（SDK 契约），helper 据此回退定义原文。 */
describe('StrategyView 查表 helper', () => {
  /** 模拟宿主 t：词典命中做 {placeholder} 插值，miss 返回 key。 */
  const t = (key: StrategyLocaleKey, params?: Record<string, unknown>): string => {
    const template = (zh as Record<string, string>)[key]
    if (template === undefined) return key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
      params[name] !== undefined ? String(params[name]) : raw)
  }

  it('strategyName/screenerName：词典命中用译文，miss 回退定义 name', () => {
    expect(strategyName({ id: 'ema-crossover', name: 'EMA 原名' }, t)).toBe(zh['strat.ema-crossover'])
    expect(screenerName({ id: 'scr.rsi-oversold', name: 'RSI 原名' }, t)).toBe(zh['scr.rsi-oversold'])
  })

  it('exitReasonText：词典键优先，momentum cause 枚举先翻译再插值，miss 回退 zh 原文', () => {
    const tr = {
      exitReason: '动量转为负值 (-2.10% / SMA 100.00)，动量衰减平仓',
      exitReasonKey: 'strat.momentum-12m.reason.exit',
      exitReasonParams: { cause: 'momentumNegative', pct: -2.1, sma: 100 },
    }
    const text = exitReasonText(tr, t)
    expect(text).toContain(zh['strat.momentum-12m.cause.momentumNegative'])
    expect(text).not.toContain('momentumNegative')
    expect(text).toContain('-2.1')

    const custom = { exitReason: '我的自定义策略退出' }
    expect(exitReasonText(custom, t)).toBe('我的自定义策略退出')
  })
})