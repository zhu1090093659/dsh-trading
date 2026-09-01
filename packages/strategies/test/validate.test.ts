/**
 * 自定义策略校验器单测（离线）：信号序列专用语义（index 单调 / time 对齐 bar /
 * action-direction 配对 / price=收盘确认价 / entry-exit 交替可复算）、结构校验、
 * node vm 熔断 runner。
 */
import { describe, expect, it } from 'vitest'
import type { Kline, StrategySignal } from '../src/index.ts'
import { validateCustomStrategy, validateSignalSequence, compileStrategySource } from '../src/validate.ts'
import { nodeStrategyComputeRunner } from '../src/validate-node.ts'

const SAMPLE_BARS: Kline[] = Array.from({ length: 30 }, (_, i) => ({
  openTime: 1700000000000 + i * 60_000,
  open: 100 + i,
  high: 101 + i,
  low: 99 + i,
  close: 100.5 + i,
  volume: 1000,
}))

function signal(overrides: Partial<StrategySignal> & { index: number }): StrategySignal {
  const bar = SAMPLE_BARS[overrides.index]!
  return {
    time: bar.openTime,
    action: 'entry',
    direction: 'long',
    price: bar.close,
    reason: 'test',
    ...overrides,
  }
}

/** 合法演示序列：entry/exit 严格交替（1 进 2 出 3 进 4 出……）。 */
function alternating(): StrategySignal[] {
  const out: StrategySignal[] = []
  for (let i = 1; i < SAMPLE_BARS.length; i++) {
    const action = i % 2 === 1 ? 'entry' : 'exit'
    out.push(signal({ index: i, action, direction: action === 'entry' ? 'long' : 'flat' }))
  }
  return out
}

describe('validateSignalSequence（引擎语义对齐）', () => {
  it('合法交替序列 → undefined', () => {
    expect(validateSignalSequence(alternating(), SAMPLE_BARS)).toBeUndefined()
  })

  it('index 重复/回退 → 单调性拒绝', () => {
    const dup = [signal({ index: 1 }), signal({ index: 1, action: 'exit', direction: 'flat' })]
    expect(validateSignalSequence(dup, SAMPLE_BARS)).toContain('严格大于前一个信号的 index')
    const back = [signal({ index: 3 }), signal({ index: 2, action: 'exit', direction: 'flat' })]
    expect(validateSignalSequence(back, SAMPLE_BARS)).toContain('严格大于前一个信号的 index')
  })

  it('time 与确认 bar 的 openTime 不一致 → 拒绝', () => {
    const bad = [signal({ index: 1, time: 1 })]
    expect(validateSignalSequence(bad, SAMPLE_BARS)).toContain('openTime')
  })

  it('direction 与 action 不配对（entry 携带 flat）→ 拒绝', () => {
    const bad = [signal({ index: 1, direction: 'flat' })]
    expect(validateSignalSequence(bad, SAMPLE_BARS)).toContain('不配对')
  })

  it('price 偏离确认 bar 收盘价 → 拒绝（i 收盘确认）', () => {
    const bad = [signal({ index: 1, price: SAMPLE_BARS[1]!.close + 10 })]
    expect(validateSignalSequence(bad, SAMPLE_BARS)).toContain('收盘价')
  })

  it('空仓 exit / 持仓再 entry → 不可复算拒绝', () => {
    expect(validateSignalSequence([signal({ index: 1, action: 'exit', direction: 'flat' })], SAMPLE_BARS))
      .toContain('没有可平的头寸')
    expect(validateSignalSequence([signal({ index: 1 }), signal({ index: 2, action: 'entry', direction: 'long' })], SAMPLE_BARS))
      .toContain('再次 entry')
  })

  it('index 越界 → 拒绝', () => {
    const bar = SAMPLE_BARS[5]!
    expect(validateSignalSequence([
      { index: 30, time: bar.openTime, action: 'entry', direction: 'long', price: bar.close, reason: 'oob' },
    ], SAMPLE_BARS)).toContain('整数')
  })
})

const VALID_SOURCE = `(bars, params) => {
  const out = []
  let long = false
  for (let i = 1; i < bars.length; i++) {
    if (!long && i % 2 === 1) { out.push({ index: i, time: bars[i].openTime, action: 'entry', direction: 'long', price: bars[i].close, reason: 'demo entry' }); long = true }
    else if (long && i % 2 === 0) { out.push({ index: i, time: bars[i].openTime, action: 'exit', direction: 'flat', price: bars[i].close, reason: 'demo exit' }); long = false }
  }
  return out
}`

const VALID_RECORD = {
  id: 'demo-alternating',
  title: '演示交替策略',
  horizon: 'swing' as const,
  summary: '奇数 bar 进、偶数 bar 出的演示策略',
  paramsJson: '[{"key":"n","label":"周期","default":5,"min":1,"max":60}]',
  computeSource: VALID_SOURCE,
  createdAt: 1700000000000,
}

// 直连 runner（同步返回值即可——AsyncComputeRunner 兼容同步形态）。
const directRunner = (source: string, bars: readonly Kline[], params: Record<string, number>) => {
  const fn = compileStrategySource(source)
  return fn(bars, params)
}

describe('validateCustomStrategy', () => {
  it('合法记录 → ok，definition 与 record 双产物（paramsJson 规格回传）', async () => {
    const result = await validateCustomStrategy(VALID_RECORD, { runner: directRunner })
    if (!result.ok) throw new Error(result.reason)
    expect(result.definition.id).toBe('demo-alternating')
    expect(result.definition.name).toBe('演示交替策略')
    expect(result.definition.params).toHaveLength(1)
    expect(result.definition.params[0]).toMatchObject({ key: 'n', default: 5 })
    expect(result.record.paramsJson).toContain('"key":"n"')
    // 试算产物：编译后的 compute 在样例上产出合法序列
    const signals = result.definition.compute(SAMPLE_BARS, { n: 5 })
    expect(validateSignalSequence(signals, SAMPLE_BARS)).toBeUndefined()
  })

  it('范式保留 id → 拒绝', async () => {
    const result = await validateCustomStrategy({ ...VALID_RECORD, id: 'ema-crossover' }, { runner: directRunner })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('保留名称')
  })

  it('paramsJson 非法 JSON / min>=max / default 越界 → 拒绝', async () => {
    const bad = await validateCustomStrategy({ ...VALID_RECORD, paramsJson: '{not json' }, { runner: directRunner })
    expect(bad).toMatchObject({ ok: false })
    const range = await validateCustomStrategy(
      { ...VALID_RECORD, paramsJson: '[{"key":"n","label":"n","default":5,"min":10,"max":20}]' },
      { runner: directRunner },
    )
    expect(range).toMatchObject({ ok: false })
  })

  it('compute 返回非数组 → 拒绝且诊断可读', async () => {
    const notArray = `(bars) => ({ key: 'ma', kind: 'line', color: '#f00', values: bars.map(x => x.close) })`
    const result = await validateCustomStrategy({ ...VALID_RECORD, computeSource: notArray }, { runner: directRunner })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('StrategySignal[]')
  })

  it('compute 返回指标式对象数组（形状不符信号契约）→ 信号序列拒绝', async () => {
    const indicatorStyle = `(bars) => bars.map(b => ({ key: 'ma', kind: 'line', color: '#f00', values: bars.map(x => x.close) }))`
    const result = await validateCustomStrategy({ ...VALID_RECORD, computeSource: indicatorStyle }, { runner: directRunner })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('信号序列校验失败')
  })

  it('信号不交替（指标式恒 entry）→ 信号序列拒绝', async () => {
    const allEntry = `(bars) => bars.slice(1).map((b, i) => ({ index: i + 1, time: b.openTime, action: 'entry', direction: 'long', price: b.close, reason: 'always in' }))`
    const result = await validateCustomStrategy({ ...VALID_RECORD, computeSource: allEntry }, { runner: directRunner })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('再次 entry')
  })

  it('死循环 compute：vm 熔断 runner 抛超时（结构化中文诊断）', async () => {
    const loop = `(bars) => { let x = 0; while (true) { x += 1 } return [] }`
    const result = await validateCustomStrategy({ ...VALID_RECORD, computeSource: loop }, { runner: nodeStrategyComputeRunner })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('超时')
  })

  it('node vm runner：arrow 源码试算产物可直接过序列校验', () => {
    const signals = nodeStrategyComputeRunner(VALID_SOURCE, SAMPLE_BARS, { n: 5 })
    expect(Array.isArray(signals)).toBe(true)
    expect(validateSignalSequence(signals, SAMPLE_BARS)).toBeUndefined()
  })
})
