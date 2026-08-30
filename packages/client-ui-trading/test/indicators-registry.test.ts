/**
 * 指标注册表与预置单测：import presets 即完成注册；校验 definition
 * 完整性、compute 输出与 K 线逐条对齐、净化/clamp 行为。
 */
import { describe, expect, it } from 'vitest'
import type { Kline } from '../src/client/types.ts'
import '../src/client/indicators/presets.ts'
import {
  clampParams, defaultInstance, defaultParams, getIndicator,
  instanceKey, listIndicators, sanitizeInstances,
} from '../src/client/indicators/registry.ts'

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
    const ids = listIndicators().map(definition => definition.id)
    expect(ids).toEqual(expect.arrayContaining(['ma', 'ema', 'boll', 'macd', 'rsi', 'kdj']))
    expect(getIndicator('ma')?.pane).toBe('main')
    expect(getIndicator('ema')?.pane).toBe('main')
    expect(getIndicator('boll')?.pane).toBe('main')
    expect(getIndicator('macd')?.pane).toBe('sub')
    expect(getIndicator('rsi')?.pane).toBe('sub')
    expect(getIndicator('kdj')?.pane).toBe('sub')
  })

  it('defaultParams/defaultInstance 取 schema 默认值', () => {
    expect(defaultParams(getIndicator('ma')!)).toEqual({ n1: 5, n2: 10, n3: 20 })
    expect(defaultInstance('ma')).toEqual({ id: 'ma', params: { n1: 5, n2: 10, n3: 20 } })
    expect(defaultInstance('nope')).toBeUndefined()
  })

  it('instanceKey 随参数变化', () => {
    expect(instanceKey({ id: 'ma', params: { n1: 5, n2: 10, n3: 20 } })).toBe('ma:5,10,20')
    expect(instanceKey({ id: 'ma', params: { n1: 5, n2: 10, n3: 30 } })).toBe('ma:5,10,30')
  })
})

describe('presets compute 输出契约', () => {
  it('所有预置输出与 K 线逐条对齐且 key 实例内唯一', () => {
    const sample = bars(80)
    for (const definition of listIndicators()) {
      const instance = defaultInstance(definition.id)
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
    const sample = bars(60)
    const ma = getIndicator('ma')!
    const [ma5] = ma.compute(sample, { n1: 5, n2: 10, n3: 20 })
    const closes = sample.slice(-5).map(bar => bar.close)
    expect(ma5?.values[59]).toBeCloseTo(closes.reduce((a, b) => a + b, 0) / 5, 10)
    expect(ma5?.values[0]).toBeUndefined()
  })

  it('MACD 柱输出 histogramBySign', () => {
    const macd = getIndicator('macd')!
    const outputs = macd.compute(bars(80), defaultParams(macd))
    expect(outputs[2]?.kind).toBe('histogram')
    expect(outputs[2]?.histogramBySign).toBe(true)
  })
})

describe('sanitize/clamp', () => {
  it('未知 id 丢弃、参数 clamp、按 id 去重、脏输入回退', () => {
    const sanitized = sanitizeInstances([
      { id: 'ma', params: { n1: 5, n2: 10, n3: 9999 } },
      { id: 'ghost', params: {} },
      { id: 'ma', params: { n1: 1, n2: 2, n3: 3 } },
      'garbage',
      null,
    ])
    expect(sanitized).toEqual([{ id: 'ma', params: { n1: 5, n2: 10, n3: 250 } }])
    expect(sanitizeInstances('nope')).toEqual([])
  })

  it('clampParams 非法值回 schema 默认', () => {
    const ma = getIndicator('ma')!
    expect(clampParams(ma, { n1: 'x', n2: 0, n3: 30 } as unknown as Record<string, number>))
      .toEqual({ n1: 5, n2: 1, n3: 30 })
  })
})
