/**
 * 指标注册表与预置单测：工厂实例 + presetDefinitions 注册；校验
 * definition 完整性、compute 输出与 K 线逐条对齐、净化/clamp 行为、
 * subscribe/version 名册通知。
 */
import { describe, expect, it } from 'vitest'
import type { Kline } from '../src/types.ts'
import { createIndicatorRegistry } from '../src/registry.ts'
import { presetDefinitions } from '../src/presets.ts'

function makeRegistry() {
  const registry = createIndicatorRegistry()
  for (const definition of presetDefinitions()) registry.register(definition)
  return registry
}

function bars(count: number): Kline[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.5 + (index % 3)
    return {
      openTime: index * 86400000,
      open: close - 0.4,
      high: close + 1.5,
      low: close - 1.5,
      close,
      volume: 1000 + index * 7,
      closeTime: index * 86400000 + 86399999,
    }
  })
}

describe('registry', () => {
  it('6 个预置已注册：主图 MA/EMA/BOLL，副图 MACD/RSI/KDJ', () => {
    const registry = makeRegistry()
    const ids = registry.list().map(definition => definition.id)
    expect(ids).toEqual(expect.arrayContaining(['ma', 'ema', 'boll', 'macd', 'rsi', 'kdj']))
    expect(registry.get('ma')?.pane).toBe('main')
    expect(registry.get('ema')?.pane).toBe('main')
    expect(registry.get('boll')?.pane).toBe('main')
    expect(registry.get('macd')?.pane).toBe('sub')
    expect(registry.get('rsi')?.pane).toBe('sub')
    expect(registry.get('kdj')?.pane).toBe('sub')
  })

  it('defaultParams/defaultInstance 取 schema 默认值', () => {
    const registry = makeRegistry()
    const ma = registry.get('ma')!
    expect(registry.defaultParams(ma)).toEqual({ n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 })
    expect(registry.defaultInstance('ma')).toEqual({ id: 'ma', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 } })
    expect(registry.defaultInstance('nope')).toBeUndefined()
  })

  it('instanceKey 随参数变化', () => {
    const registry = makeRegistry()
    expect(registry.instanceKey({ id: 'ma', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 } })).toBe('ma:5,10,20,30,60,120')
    expect(registry.instanceKey({ id: 'ma', params: { n1: 5, n2: 10, n3: 30, n4: 30, n5: 60, n6: 120 } })).toBe('ma:5,10,30,30,60,120')
  })

  it('register 通知订阅者且 version 单调递增', () => {
    const registry = createIndicatorRegistry()
    let notices = 0
    const versions: number[] = []
    const unsubscribe = registry.subscribe(() => { notices += 1; versions.push(registry.getVersion()) })
    registry.register(presetDefinitions()[0]!)
    registry.register(presetDefinitions()[1]!)
    unsubscribe()
    registry.register(presetDefinitions()[2]!)
    expect(notices).toBe(2)
    expect(versions).toEqual([1, 2])
  })
})

describe('presets compute 输出契约', () => {
  it('所有预置输出与 K 线逐条对齐且 key 实例内唯一', () => {
    const registry = makeRegistry()
    const sample = bars(80)
    for (const definition of registry.list()) {
      const instance = registry.defaultInstance(definition.id)
      if (instance === undefined) throw new Error(`default instance missing: ${definition.id}`)
      const outputs = definition.compute(sample, instance.params)
      expect(outputs.length, definition.id).toBeGreaterThan(0)
      const keys = new Set<string>()
      for (const output of outputs) {
        expect(output.values, `${definition.id}.${output.key}`).toHaveLength(sample.length)
        expect(keys.has(output.key)).toBe(false)
        keys.add(output.key)
      }
    }
  })

  it('MA 输出尾部值 = 最近 N 个收盘均值（迁移自 chart-layout 金值）', () => {
    const registry = makeRegistry()
    const sample = bars(60)
    const ma = registry.get('ma')!
    const [ma5] = ma.compute(sample, { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 })
    const closes = sample.slice(-5).map(bar => bar.close)
    expect(ma5?.values[59]).toBeCloseTo(closes.reduce((a, b) => a + b, 0) / 5, 10)
    expect(ma5?.values[0]).toBeUndefined()
  })

  it('MA / EMA 设置周期为 0 时该线被隐藏（不输出该 line）', () => {
    const registry = makeRegistry()
    const sample = bars(60)
    const ma = registry.get('ma')!
    const outputs = ma.compute(sample, { n1: 5, n2: 10, n3: 0, n4: 0, n5: 0, n6: 0 })
    expect(outputs.map(o => o.key)).toEqual(['MA5', 'MA10'])
  })

  it('MACD 柱输出 histogramBySign', () => {
    const registry = makeRegistry()
    const macd = registry.get('macd')!
    const outputs = macd.compute(bars(80), registry.defaultParams(macd))
    expect(outputs[2]?.kind).toBe('histogram')
    expect(outputs[2]?.histogramBySign).toBe(true)
  })
})

describe('sanitize/clamp', () => {
  it('未知 id 丢弃、参数 clamp、按 id 去重、脏输入回退', () => {
    const registry = makeRegistry()
    const sanitized = registry.sanitizeInstances([
      { id: 'ma', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 9999 } },
      { id: 'ghost', params: {} },
      { id: 'ma', params: { n1: 1, n2: 2, n3: 3, n4: 4, n5: 5, n6: 6 } },
      'garbage',
      null,
    ])
    expect(sanitized).toEqual([{ id: 'ma', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 250 } }])
    expect(registry.sanitizeInstances('nope')).toEqual([])
  })

  it('clampParams 非法值回 schema 默认', () => {
    const registry = makeRegistry()
    const ma = registry.get('ma')!
    expect(registry.clampParams(ma, { n1: 'x', n2: 0, n3: 30 } as unknown as Record<string, number>))
      .toEqual({ n1: 5, n2: 0, n3: 30, n4: 30, n5: 60, n6: 120 })
  })
})
