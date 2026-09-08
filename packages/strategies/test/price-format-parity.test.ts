/**
 * 价格文案小数位规则「单一来源 ↔ 五份内联副本」一致性守卫（2026-09-08 价格 3 位小数修复）。
 *
 * 规则本体在 src/price-format.ts；范式 compute 因需自包含（compute.toString() 要能导出
 * 可编译源码）各自内联同式实现。本表用含 3 位小数价格的短序列跑每个范式，断言产出的
 * reason / reasonParams 价格文案 === 规范 fmtPrice() 结果：
 * 任一侧单边改动（只改 price-format.ts，或只改某份内联副本）本文件立刻红；
 * 两侧同步改坏也不会互相抵消——reason / reasonParams 的字面量钉死必须显式更新。
 */
import { describe, expect, it } from 'vitest'
import { fmtPrice } from '../src/price-format.ts'
import {
  bollingerReversionStrategy,
  donchianBreakoutStrategy,
  emaCrossoverStrategy,
  momentum12mStrategy,
  smaBaselineStrategy,
} from '../src/paradigms/index.ts'
import type { Kline, SignalAction, StrategyDefinition } from '../src/types.ts'

const BASE_TIME = 1700000000000
const DAY = 86_400_000

/** 单根 K 线（high/low 缺省等于 close；只用到 close 的策略无需单独给影线）。 */
function bar(index: number, close: number, high = close, low = close): Kline {
  return { openTime: BASE_TIME + index * DAY, open: close, high, low, close, volume: 1000 }
}

/*
 * 参考实现：公式与 src/paradigms/*.ts 的内联版逐字对应，只用于取出源实现写入文案的
 * 同一个双精度数（不校验策略数学，只对齐文案里的价格来源）。
 */
function smaRef(values: readonly number[], period: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined)
  if (values.length < period) return out
  let sum = 0
  for (let index = 0; index < values.length; index++) {
    sum += values[index] as number
    if (index >= period) sum -= values[index - period] as number
    if (index >= period - 1) out[index] = sum / period
  }
  return out
}

function sdRef(values: readonly number[], period: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined)
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

function emaRef(values: readonly number[], period: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined)
  if (values.length < period) return out
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

/** 取参考序列的确定值（夹具自造，缺值即夹具写错）。 */
function valueAt(series: ReadonlyArray<number | undefined>, index: number): number {
  const value = series[index]
  if (value === undefined) throw new Error(`参考序列在下标 ${index} 处无值——夹具失效`)
  return value
}

const closesOf = (bars: readonly Kline[]): number[] => bars.map(entry => entry.close)

/* ------------------------------ 夹具（五段短序列，都含 3 位小数价格） ------------------------------ */

/** 唐奇安：前 3 根高点 107.125 → 第 4 根 108.125 突破；第 5 根 105.625 跌破前 2 根最低价 106.875。 */
const DONCHIAN_BARS: readonly Kline[] = [
  bar(0, 107, 107.125, 106.875),
  bar(1, 107, 107.125, 106.875),
  bar(2, 107, 107.125, 106.875),
  bar(3, 108.125, 108.5, 107.5),
  bar(4, 105.625, 106, 105),
]

/** 布林：前 4 根 100.125 → 第 5 根 99 跌破下轨 99.225；第 6 根 100.375 回归中轨 99.95。 */
const BOLLINGER_PERIOD = 5
const BOLLINGER_K = 1.5
const BOLLINGER_BARS: readonly Kline[] = [
  bar(0, 100.125),
  bar(1, 100.125),
  bar(2, 100.125),
  bar(3, 100.125),
  bar(4, 99),
  bar(5, 100.375),
]
const BOLLINGER_CLOSES = closesOf(BOLLINGER_BARS)
const BOLLINGER_MID = smaRef(BOLLINGER_CLOSES, BOLLINGER_PERIOD)
const BOLLINGER_SD = sdRef(BOLLINGER_CLOSES, BOLLINGER_PERIOD)
const BOLLINGER_BAND = BOLLINGER_MID.map((mid, index) => {
  const sd = BOLLINGER_SD[index]
  return mid === undefined || sd === undefined ? undefined : mid - BOLLINGER_K * sd
})

/** 均线基线：10 根 100.125/100.625 交替 → SMA 100.425；第 10 根 101.125 站上，第 11 根 99.875 跌破。 */
const SMA_PERIOD = 10
const SMA_BARS: readonly Kline[] = [
  bar(0, 100.125),
  bar(1, 100.625),
  bar(2, 100.125),
  bar(3, 100.625),
  bar(4, 100.125),
  bar(5, 100.625),
  bar(6, 100.125),
  bar(7, 100.625),
  bar(8, 100.125),
  bar(9, 101.125),
  bar(10, 99.875),
]
const SMA_REF = smaRef(closesOf(SMA_BARS), SMA_PERIOD)

/** 12 月动量：10 根 100.125 为回溯基期 → 第 11 根 101.125 动量为正且站上均线 100.225；第 12 根 99.875 动量转负。 */
const MOMENTUM_LOOKBACK = 10
const MOMENTUM_BARS: readonly Kline[] = [
  ...Array.from({ length: MOMENTUM_LOOKBACK }, (_, index) => bar(index, 100.125)),
  bar(MOMENTUM_LOOKBACK, 101.125),
  bar(MOMENTUM_LOOKBACK + 1, 99.875),
]
const MOMENTUM_REF = smaRef(closesOf(MOMENTUM_BARS), MOMENTUM_LOOKBACK)

/** EMA 双均线：前 4 根 100.125（快线=慢线）→ 第 5 根 101.125 金叉（快线 100.792 / 慢线 100.625）。 */
const EMA_FAST = 2
const EMA_SLOW = 3
const EMA_BARS: readonly Kline[] = [
  bar(0, 100.125),
  bar(1, 100.125),
  bar(2, 100.125),
  bar(3, 100.125),
  bar(4, 101.125),
]
const EMA_FAST_REF = emaRef(closesOf(EMA_BARS), EMA_FAST)
const EMA_SLOW_REF = emaRef(closesOf(EMA_BARS), EMA_SLOW)

/* ------------------------------------------ 表驱动期望 ------------------------------------------ */

interface ExpectedSignal {
  readonly index: number
  readonly action: SignalAction
  /** 信号确认时的收盘价（= 对应 K 线 close，钉住信号落在哪根）。 */
  readonly close: number
  /** 文案里出现的价格参考值：key 与 reasonParams 的价格键一一对应。 */
  readonly values: Readonly<Record<string, number>>
  /** 语义钉死：两侧规则同步改动（或都退回 2 位）时也必须显式改本表。 */
  readonly reasonParams: Readonly<Record<string, string | number>>
  readonly reason: string
}

interface ParityCase {
  readonly name: string
  readonly compute: StrategyDefinition['compute']
  readonly bars: readonly Kline[]
  readonly params: Readonly<Record<string, number>>
  readonly expected: readonly ExpectedSignal[]
}

const CASES: readonly ParityCase[] = [
  {
    name: 'donchian-breakout',
    compute: donchianBreakoutStrategy.compute,
    bars: DONCHIAN_BARS,
    params: { lookbackEntry: 3, lookbackExit: 2 },
    expected: [
      {
        index: 3,
        action: 'entry',
        close: 108.125,
        values: { close: 108.125, high: 107.125 },
        reasonParams: { close: '108.125', n: 3, high: '107.125' },
        reason: '收盘价 (108.125) 突破前 3 根最高价 (107.125)',
      },
      {
        index: 4,
        action: 'exit',
        close: 105.625,
        values: { close: 105.625, low: 106.875 },
        reasonParams: { close: '105.625', n: 2, low: '106.875' },
        reason: '收盘价 (105.625) 跌破前 2 根最低价 (106.875)',
      },
    ],
  },
  {
    name: 'bollinger-reversion',
    compute: bollingerReversionStrategy.compute,
    bars: BOLLINGER_BARS,
    params: { period: BOLLINGER_PERIOD, multiplier: BOLLINGER_K },
    expected: [
      {
        index: 4,
        action: 'entry',
        close: 99,
        values: { close: 99, band: valueAt(BOLLINGER_BAND, 4) },
        reasonParams: { close: '99.00', band: '99.225' },
        reason: '收盘价 (99.00) 跌破布林下轨 (99.225)，触发波段均值回归',
      },
      {
        index: 5,
        action: 'exit',
        close: 100.375,
        values: { close: 100.375, mid: valueAt(BOLLINGER_MID, 5) },
        reasonParams: { close: '100.375', mid: '99.95' },
        reason: '收盘价 (100.375) 成功回归至布林中轨 (99.95)，完成目标止盈',
      },
    ],
  },
  {
    name: 'sma-baseline',
    compute: smaBaselineStrategy.compute,
    bars: SMA_BARS,
    params: { period: SMA_PERIOD },
    expected: [
      {
        index: 9,
        action: 'entry',
        close: 101.125,
        values: { close: 101.125, sma: valueAt(SMA_REF, 9) },
        reasonParams: { close: '101.125', period: SMA_PERIOD, sma: '100.425' },
        reason: '收盘价 (101.125) 站上长期基线 SMA(10) (100.425)，确立多头趋势',
      },
      {
        index: 10,
        action: 'exit',
        close: 99.875,
        values: { close: 99.875, sma: valueAt(SMA_REF, 10) },
        reasonParams: { close: '99.875', period: SMA_PERIOD, sma: '100.40' },
        reason: '收盘价 (99.875) 跌破长期基线 SMA(10) (100.40)，转入防御避险',
      },
    ],
  },
  {
    name: 'momentum-12m',
    compute: momentum12mStrategy.compute,
    bars: MOMENTUM_BARS,
    params: { lookbackBars: MOMENTUM_LOOKBACK },
    expected: [
      {
        index: 10,
        action: 'entry',
        close: 101.125,
        values: { sma: valueAt(MOMENTUM_REF, 10) },
        reasonParams: { n: MOMENTUM_LOOKBACK, pct: '1.0', sma: '100.225' },
        reason: '近 10 周期动量为正 (+1.0%) 且位于均线 (100.225) 之上，确认强动量',
      },
      {
        index: 11,
        action: 'exit',
        close: 99.875,
        values: { sma: valueAt(MOMENTUM_REF, 11) },
        reasonParams: { cause: 'momentumNegative', pct: '-0.2', sma: '100.20' },
        reason: '动量转为负值 (-0.2% / SMA 100.20)，动量衰减平仓',
      },
    ],
  },
  {
    name: 'ema-crossover',
    compute: emaCrossoverStrategy.compute,
    bars: EMA_BARS,
    params: { fastPeriod: EMA_FAST, slowPeriod: EMA_SLOW },
    expected: [
      {
        index: 4,
        action: 'entry',
        close: 101.125,
        values: { fast: valueAt(EMA_FAST_REF, 4), slow: valueAt(EMA_SLOW_REF, 4) },
        reasonParams: { fastP: EMA_FAST, fast: '100.792', slowP: EMA_SLOW, slow: '100.625' },
        reason: 'EMA(2) (100.792) 上穿 EMA(3) (100.625) 形成金叉',
      },
    ],
  },
]

describe('价格文案小数位：规范 fmtPrice 与五份内联副本一致（3 位小数序列）', () => {
  it.each(CASES)('$name：reason / reasonParams 的价格文案 === fmtPrice(参考值)', (testCase) => {
    const signals = testCase.compute(testCase.bars, testCase.params)
    expect(signals.map(signal => `${signal.index}:${signal.action}`))
      .toEqual(testCase.expected.map(entry => `${entry.index}:${entry.action}`))

    testCase.expected.forEach((expected, position) => {
      const signal = signals[position]
      expect(signal, `${testCase.name} 缺第 ${position} 个信号`).toBeDefined()
      if (signal === undefined) return

      expect(signal.price).toBe(expected.close)

      // 与规范 fmtPrice 同源：price-format.ts 或内联副本单边改动 → 这里立刻不等。
      for (const [key, value] of Object.entries(expected.values)) {
        expect(signal.reason, `${testCase.name}.reason 缺 ${key} 的价格文案`).toContain(fmtPrice(value))
        expect(signal.reasonParams?.[key], `${testCase.name}.reasonParams.${key}`).toBe(fmtPrice(value))
      }

      // 语义钉死：两侧规则同步改坏不会互相抵消，必须显式改本表。
      expect(signal.reason).toBe(expected.reason)
      expect(signal.reasonParams).toEqual(expected.reasonParams)
    })
  })

  it('每个范式的夹具都落在「2 位舍入丢第 3 位小数 → 升 3 位」分支上（否则本文件失去判别力）', () => {
    for (const testCase of CASES) {
      // 只取价格键（pct 之类百分比文案不参与小数位规则）。
      const priceTexts = testCase.expected.flatMap(entry =>
        Object.keys(entry.values)
          .map(key => entry.reasonParams[key])
          .filter((value): value is string => typeof value === 'string'))
      // 至少一个价格文案在 2 位舍入下会变——证明序列确实触发了升位分支。
      expect(
        priceTexts.some(text => Number(text).toFixed(2) !== text),
        `${testCase.name} 的夹具没触发 3 位小数分支：${priceTexts.join(', ')}`,
      ).toBe(true)
      // 每个价格文案都是规范 fmtPrice 的不动点（文案自身自洽）。
      for (const text of priceTexts) expect(fmtPrice(Number(text)), text).toBe(text)
    }
  })
})
