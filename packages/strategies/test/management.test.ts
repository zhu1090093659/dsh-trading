/**
 * 策略管理单测（2026-09-07）：覆盖 + 墓碑模型。
 *
 * - applyStrategyManagement 名册合成：墓碑剔除 / 覆盖原位替换 / 自定义追加。
 * - builtinStrategySource 往返：全部内置范式的导出源码必须通过 Node 沙箱全量
 *   校验（5 场景试算 + 信号序列可复算），且编译后行为与原 compute 逐信号一致
 *   ——这是 GUI「编辑内置」预填源码的构建期安全网（内联数学自包含的前提）。
 * - 墓碑存储（内存 + 文件）语义。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyStrategyManagement,
  builtinStrategyRecord,
  builtinStrategySource,
  createMemoryBuiltinTombstonesStore,
  createMemoryCustomStrategyStore,
  strategyParadigms,
  type Kline,
  type StrategyDefinition,
} from '../src/index.ts'
import { compileStrategySource, validateCustomStrategy } from '../src/validate.ts'
import { validateCustomStrategyNode } from '../src/validate-node.ts'
import { createFileBuiltinTombstonesStore } from '../src/builtin-tombstones-fs.ts'

/** 确定性 K 线：先涨后跌再涨，足够触发全部范式的信号（窗口最长 300）。 */
function sampleBars(count = 320): Kline[] {
  const bars: Kline[] = []
  let price = 100
  for (let i = 0; i < count; i++) {
    const drift = i < count / 3 ? 0.6 : i < (count * 2) / 3 ? -0.5 : 0.55
    price = Math.max(1, price + drift)
    bars.push({
      openTime: 1700000000000 + i * 86_400_000,
      open: price - drift / 2,
      high: price + 0.4,
      low: price - 0.4,
      close: price,
      volume: 1000 + (i % 7) * 50,
    })
  }
  return bars
}

describe('builtinStrategySource 往返（全部内置范式）', () => {
  const bars = sampleBars()

  for (const def of strategyParadigms) {
    it(`${def.id}：源码通过全量校验且行为与原 compute 一致`, async () => {
      const source = builtinStrategySource(def)
      expect(source.length).toBeGreaterThan(0)
      expect(source.length).toBeLessThanOrEqual(16 * 1024)

      const record = builtinStrategyRecord(def)
      const result = await validateCustomStrategyNode(record)
      expect(result.ok).toBe(true)

      // 行为等价：导出源码编译后在同序列上产出与原 compute 相同的信号。
      const compiled = compileStrategySource(source)
      const original = def.compute(bars, defParams(def))
      const replayed = compiled(bars, defParams(def))
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(original))
    })
  }

  function defParams(def: StrategyDefinition): Record<string, number> {
    const out: Record<string, number> = {}
    for (const p of def.params) out[p.key] = p.default
    return out
  }
})

describe('applyStrategyManagement 名册合成', () => {
  const builtin = strategyParadigms[0]!
  const builtin2 = strategyParadigms[1]!

  function fakeDef(id: string, name: string): StrategyDefinition {
    return {
      id, horizon: 'short', name, summary: 'x',
      params: [],
      compute: () => [],
    }
  }

  it('无管理状态时 = 范式原样', () => {
    const roster = applyStrategyManagement(strategyParadigms, [], [])
    expect(roster.map((d) => d.id)).toEqual(strategyParadigms.map((d) => d.id))
  })

  it('覆盖记录原位替换内置；自定义追加在尾', () => {
    const override = fakeDef(builtin.id, '覆盖版')
    const custom = fakeDef('my-custom', '自定义')
    const roster = applyStrategyManagement(strategyParadigms, [override, custom], [])
    expect(roster[0]!.id).toBe(builtin.id)
    expect(roster[0]!.name).toBe('覆盖版')
    expect(roster.at(-1)!.id).toBe('my-custom')
    expect(roster).toHaveLength(strategyParadigms.length + 1)
  })

  it('墓碑剔除内置；被墓碑命中的覆盖也不出现', () => {
    const override = fakeDef(builtin.id, '覆盖版')
    const roster = applyStrategyManagement(strategyParadigms, [override], [builtin.id])
    expect(roster.some((d) => d.id === builtin.id)).toBe(false)
    expect(roster.some((d) => d.id === builtin2.id)).toBe(true)
  })
})

describe('墓碑存储', () => {
  it('内存版：add/list/remove 幂等', async () => {
    const store = createMemoryBuiltinTombstonesStore()
    expect(await store.add('ema-crossover')).toBe(true)
    expect(await store.add('ema-crossover')).toBe(false)
    expect(await store.list()).toEqual(['ema-crossover'])
    expect(await store.remove('ema-crossover')).toBe(true)
    expect(await store.remove('ema-crossover')).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('文件版：跨实例往返（tmp 目录）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strategies-tombstones-'))
    const path = join(dir, 'builtin-tombstones.json')
    const first = createFileBuiltinTombstonesStore(path)
    await first.add('donchian-breakout')
    await first.add('scr.ma-bull-align')
    // 新实例从盘上恢复（file store 每实例一份内存缓存——这正是 SSOT 单实例
    // 收口的原因，见 plugin.ts 的 tradingStrategies Service）。
    const second = createFileBuiltinTombstonesStore(path)
    expect(await second.list()).toEqual(['donchian-breakout', 'scr.ma-bull-align'])
    await second.remove('donchian-breakout')
    const third = createFileBuiltinTombstonesStore(path)
    expect(await third.list()).toEqual(['scr.ma-bull-align'])
  })
})

describe('校验器：覆盖语义与参数 step', () => {
  it('paramsJson 保留合法 step（内置覆盖不失真）', async () => {
    const result = await validateCustomStrategy({
      id: 'step-check',
      title: '步进',
      horizon: 'short',
      summary: 'x',
      paramsJson: JSON.stringify([{ key: 'k', label: 'K', default: 2, min: 1, max: 4, step: 0.5 }]),
      computeSource: '(bars, params) => []',
      createdAt: 1,
    })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.definition.params[0]?.step).toBe(0.5)
  })

  it('内置同 id 记录（覆盖）→ 校验放行且 GUI 拉取路径同源', async () => {
    const def = strategyParadigms[0]!
    const result = await validateCustomStrategy(builtinStrategyRecord(def), { runner: undefined })
    expect(result).toMatchObject({ ok: true })
  })
})

describe('builtinStrategyRecord 预填', () => {
  it('元数据与参数序列化保留 step，可直接过校验', async () => {
    const def = strategyParadigms.find((d) => d.id === 'bollinger-reversion')!
    const record = builtinStrategyRecord(def)
    expect(record.id).toBe('bollinger-reversion')
    expect(record.paramsJson).toContain('"step":0.5')
    const result = await validateCustomStrategyNode(record)
    expect(result.ok).toBe(true)
  })
})
