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

/**
 * 内联数学 parity（2026-09-07 审查补强）：往返测试两侧都是内联代码，只能证明
 * toString/compile 保真；本组测试用 indicators 包的 ema/sma/rsi/bollinger 手工
 * 重建各范式的判定逻辑（循环起点、undefined 跳过与入场/出场谓词逐条对照源实现），
 * 与内联版 compute 在同一序列上逐信号比对——
 * 锁死「内联数学 ≡ indicators 数学」这一内联改写的语义前提。
 * 比较面 = 信号核心字段（index/time/action/direction/price）；reason/reasonKey
 * 是文案层（内联版带 i18n 插值，重建版是简化标注），不在数学等价范围内。
 */
function signalCore(signals: readonly { index: number; time: number; action: string; direction: string; price: number }[]): Array<Record<string, unknown>> {
  return signals.map((s) => ({ index: s.index, time: s.time, action: s.action, direction: s.direction, price: s.price }))
}

function expectSignalsEqual(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(signalCore(actual as never))).toBe(JSON.stringify(signalCore(expected as never)))
}
describe('内联数学 parity：内联 compute ≡ indicators 包重建（全部 5 个指标类范式）', () => {
  const bars = sampleBars(400)
  const closes = bars.map((b) => b.close)

  function defParams(def: StrategyDefinition): Record<string, number> {
    const out: Record<string, number> = {}
    for (const p of def.params) out[p.key] = p.default
    return out
  }

  it('ema-crossover：内联 emaOf ≡ indicators.ema（SMA 种子，信号级）', async () => {
    const { ema } = await import('@dshtrading/indicators')
    const def = strategyParadigms.find((d) => d.id === 'ema-crossover')!
    const params = defParams(def)
    const fastP = Math.max(2, Math.round(params.fastPeriod ?? 20))
    const slowP = Math.max(fastP + 1, Math.round(params.slowPeriod ?? 60))
    const fast = ema(closes, fastP)
    const slow = ema(closes, slowP)
    const reference: StrategyDefinition['compute'] = (seq) => {
      const signals = []
      let inPosition = false
      for (let i = 1; i < seq.length; i++) {
        const prevFast = fast[i - 1]
        const prevSlow = slow[i - 1]
        const currFast = fast[i]
        const currSlow = slow[i]
        if (prevFast === undefined || prevSlow === undefined || currFast === undefined || currSlow === undefined) continue
        // 谓词对照 ema-crossover.ts：金叉 prevFast<=prevSlow && currFast>currSlow；
        // 死叉 prevFast>=prevSlow && currFast<currSlow。
        if (!inPosition && prevFast <= prevSlow && currFast > currSlow) {
          signals.push({ index: i, time: seq[i].openTime, action: 'entry', direction: 'long', price: seq[i].close, reason: 'golden' })
          inPosition = true
        } else if (inPosition && prevFast >= prevSlow && currFast < currSlow) {
          signals.push({ index: i, time: seq[i].openTime, action: 'exit', direction: 'flat', price: seq[i].close, reason: 'dead' })
          inPosition = false
        }
      }
      return signals
    }
    expectSignalsEqual(def.compute(bars, params), reference(bars, params))
  })

  it('rsi-reversion：内联 rsiOf ≡ indicators.rsi（Wilder，信号级）', async () => {
    const { rsi } = await import('@dshtrading/indicators')
    const def = strategyParadigms.find((d) => d.id === 'rsi-reversion')!
    const params = defParams(def)
    const period = Math.max(2, Math.round(params.period ?? 2))
    const enterThresh = Number(params.entryThreshold ?? 10)
    const exitThresh = Number(params.exitThreshold ?? 60)
    const rsiValues = rsi(closes, period)
    const reference: StrategyDefinition['compute'] = (seq) => {
      const signals = []
      let inPosition = false
      // 循环起点对照 rsi-reversion.ts：i 从 0 起（含 warm-up 位的 undefined 跳过）。
      for (let i = 0; i < seq.length; i++) {
        const val = rsiValues[i]
        if (val === undefined || Number.isNaN(val)) continue
        if (!inPosition && val < enterThresh) {
          signals.push({ index: i, time: seq[i].openTime, action: 'entry', direction: 'long', price: seq[i].close, reason: 'oversold' })
          inPosition = true
        } else if (inPosition && val > exitThresh) {
          signals.push({ index: i, time: seq[i].openTime, action: 'exit', direction: 'flat', price: seq[i].close, reason: 'rebound' })
          inPosition = false
        }
      }
      return signals
    }
    expectSignalsEqual(def.compute(bars, params), reference(bars, params))
  })

  it('sma-baseline：内联 smaOf ≡ indicators.sma（信号级）', async () => {
    const { sma } = await import('@dshtrading/indicators')
    const def = strategyParadigms.find((d) => d.id === 'sma-baseline')!
    const params = defParams(def)
    const period = Math.max(10, Math.round(params.period ?? 200))
    const smaValues = sma(closes, period)
    const reference: StrategyDefinition['compute'] = (seq) => {
      const signals = []
      let inPosition = false
      // 循环起点对照 sma-baseline.ts：i 从 period-1 起。
      for (let i = period - 1; i < seq.length; i++) {
        const ma = smaValues[i]
        if (ma === undefined) continue
        if (!inPosition && seq[i].close > ma) {
          signals.push({ index: i, time: seq[i].openTime, action: 'entry', direction: 'long', price: seq[i].close, reason: 'above' })
          inPosition = true
        } else if (inPosition && seq[i].close < ma) {
          signals.push({ index: i, time: seq[i].openTime, action: 'exit', direction: 'flat', price: seq[i].close, reason: 'below' })
          inPosition = false
        }
      }
      return signals
    }
    expectSignalsEqual(def.compute(bars, params), reference(bars, params))
  })

  it('momentum-12m：内联 smaOf ≡ indicators.sma（信号级）', async () => {
    const { sma } = await import('@dshtrading/indicators')
    const def = strategyParadigms.find((d) => d.id === 'momentum-12m')!
    const params = defParams(def)
    const lookback = Math.max(10, Math.round(params.lookbackBars ?? 250))
    const smaValues = sma(closes, lookback)
    const reference: StrategyDefinition['compute'] = (seq) => {
      const signals = []
      let inPosition = false
      // 循环起点与谓词对照 momentum-12m.ts：i 从 lookback 起；pastClose<=0 跳过；
      // 入场 momentum>0 && close>sma；出场 momentum<=0 || close<sma。
      for (let i = lookback; i < seq.length; i++) {
        const currentClose = seq[i].close
        const pastClose = seq[i - lookback].close
        const currentSma = smaValues[i]
        if (pastClose <= 0 || currentSma === undefined) continue
        const momentumReturn = (currentClose - pastClose) / pastClose
        if (!inPosition && momentumReturn > 0 && currentClose > currentSma) {
          signals.push({ index: i, time: seq[i].openTime, action: 'entry', direction: 'long', price: currentClose, reason: 'momentum' })
          inPosition = true
        } else if (inPosition && (momentumReturn <= 0 || currentClose < currentSma)) {
          signals.push({ index: i, time: seq[i].openTime, action: 'exit', direction: 'flat', price: currentClose, reason: 'fade' })
          inPosition = false
        }
      }
      return signals
    }
    expectSignalsEqual(def.compute(bars, params), reference(bars, params))
  })

  it('bollinger-reversion：内联 stdevOf/smaOf ≡ indicators.bollinger（信号级）', async () => {
    const { bollinger } = await import('@dshtrading/indicators')
    const def = strategyParadigms.find((d) => d.id === 'bollinger-reversion')!
    const params = defParams(def)
    const period = Math.max(5, Math.round(params.period ?? 20))
    const k = Number(params.multiplier ?? 2)
    const { mid, lower } = bollinger(closes, period, k)
    const reference: StrategyDefinition['compute'] = (seq) => {
      const signals = []
      let inPosition = false
      // 循环起点与谓词对照 bollinger-reversion.ts：i 从 period-1 起；
      // 入场 close < lower；出场 close >= mid。
      for (let i = period - 1; i < seq.length; i++) {
        const currentLower = lower[i]
        const currentMid = mid[i]
        if (currentLower === undefined || currentMid === undefined) continue
        if (!inPosition && seq[i].close < currentLower) {
          signals.push({ index: i, time: seq[i].openTime, action: 'entry', direction: 'long', price: seq[i].close, reason: 'below' })
          inPosition = true
        } else if (inPosition && seq[i].close >= currentMid) {
          signals.push({ index: i, time: seq[i].openTime, action: 'exit', direction: 'flat', price: seq[i].close, reason: 'mid' })
          inPosition = false
        }
      }
      return signals
    }
    expectSignalsEqual(def.compute(bars, params), reference(bars, params))
  })
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

describe('覆盖记录归档（2026-09-07 审查补强：丢弃的 override 可找回）', () => {
  it('file store remove(id, true)：记录归档到 .archive.jsonl 且从主文件消失', async () => {
    const { createFileCustomStrategyStore, readArchivedStrategyRecords } = await import('../src/custom-fs.ts')
    const dir = await mkdtemp(join(tmpdir(), 'strategies-archive-'))
    const path = join(dir, 'custom.json')
    const store = createFileCustomStrategyStore(path)
    await store.save({
      id: 'ema-crossover', title: '旧覆盖', horizon: 'swing', summary: 'x',
      paramsJson: '[]', computeSource: '(bars) => []', createdAt: 1,
    })
    expect(await store.remove('ema-crossover', true)).toBe(true)
    // 主文件已删；归档文件含被删记录。
    expect(await store.get('ema-crossover')).toBeUndefined()
    const archived = await readArchivedStrategyRecords(`${path}.archive.jsonl`)
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatchObject({ id: 'ema-crossover', title: '旧覆盖' })
    // 非归档删除不写归档。
    await store.save({
      id: 'my-custom', title: 'x', horizon: 'swing', summary: 'x',
      paramsJson: '[]', computeSource: '(bars) => []', createdAt: 2,
    })
    await store.remove('my-custom')
    expect(await readArchivedStrategyRecords(`${path}.archive.jsonl`)).toHaveLength(1)
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
