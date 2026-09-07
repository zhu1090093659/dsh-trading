/**
 * 选股器管理单测（2026-09-07）：覆盖 + 墓碑模型在选股器侧的全链路。
 *
 * - 内置选股器 evaluate 源码往返：全部 5 个内置的导出源码必须通过 Node 沙箱
 *   全量校验（多场景试算 + ScreenerMatch 形状），且行为与原 evaluate 一致。
 * - validateCustomScreener：结构/columns/metrics 键域/reason 校验。
 * - screener_author / screener_delete / screener_reset 工具 + 墓碑联动。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  applyScreenerManagement,
  builtinScreenerRecord,
  builtinScreenerSource,
  createMemoryBuiltinTombstonesStore,
  createMemoryCustomScreenerStore,
  screenerParadigms,
  validateCustomScreener,
  type Kline,
  type ScreenerDefinition,
} from '../src/index.ts'
import { compileStrategySource } from '../src/validate.ts'
import { validateCustomScreenerNode } from '../src/validate-node.ts'
import {
  createScreenerAuthorTool,
  createScreenerDeleteTool,
  createScreenerResetTool,
} from '../src/plugin.ts'

/** 确定性 K 线：带量价结构的上行序列（供截面试算）。 */
function sampleBars(count = 300): Kline[] {
  const bars: Kline[] = []
  let price = 100
  for (let i = 0; i < count; i++) {
    price += 0.5
    bars.push({
      openTime: 1700000000000 + i * 86_400_000,
      open: price - 0.25,
      high: price + 0.4,
      low: price - 0.4,
      close: price,
      volume: 1000 + (i % 5) * 200,
    })
  }
  return bars
}

describe('builtinScreenerSource 往返（全部内置选股器）', () => {
  const bars = sampleBars()

  for (const def of screenerParadigms) {
    it(`${def.id}：源码通过全量校验且行为与原 evaluate 一致`, async () => {
      const source = builtinScreenerSource(def)
      expect(source.length).toBeGreaterThan(0)
      expect(source.length).toBeLessThanOrEqual(16 * 1024)

      const result = await validateCustomScreenerNode(builtinScreenerRecord(def))
      expect(result.ok).toBe(true)

      const compiled = compileStrategySource(source) as unknown as ScreenerDefinition['evaluate']
      const defParams = (d: ScreenerDefinition): Record<string, number> => {
        const out: Record<string, number> = {}
        for (const p of d.params) out[p.key] = p.default
        return out
      }
      const original = def.evaluate(bars, defParams(def))
      const replayed = compiled(bars, defParams(def))
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(original))
    })
  }
})

describe('validateCustomScreener', () => {
  const VALID = {
    id: 'scr.custom-momentum',
    title: '自定义动量',
    horizon: 'swing' as const,
    summary: 'x',
    paramsJson: '[]',
    columnsJson: JSON.stringify([{ key: 'mom', label: '动量', format: 'percent' }]),
    evaluateSource: `(bars) => {
      if (bars.length < 2) return null
      const mom = (bars[bars.length - 1].close - bars[0].close) / bars[0].close * 100
      if (mom <= 0) return null
      return { metrics: { mom }, reason: '动量为正' }
    }`,
    createdAt: 1,
  }

  it('合法记录 → 通过，定义/记录回读一致', async () => {
    const result = await validateCustomScreenerNode(VALID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.id).toBe('scr.custom-momentum')
      expect(result.definition.columns.map((c) => c.key)).toEqual(['mom'])
    }
  })

  it('非 scr. 前缀 id → 拒绝', async () => {
    const result = await validateCustomScreenerNode({ ...VALID, id: 'my-screener' })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('scr.')
  })

  it('metrics 键未在 columns 声明 → 试算期拒绝', async () => {
    const result = await validateCustomScreenerNode({
      ...VALID,
      columnsJson: JSON.stringify([{ key: 'other', label: '其他' }]),
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('columns')
  })

  it('返回非 ScreenerMatch 形状 → 拒绝', async () => {
    const result = await validateCustomScreenerNode({ ...VALID, evaluateSource: '(bars) => "hit"' })
    expect(result).toMatchObject({ ok: false })
  })

  it('columnsJson 缺失或空数组 → 拒绝', async () => {
    expect(await validateCustomScreenerNode({ ...VALID, columnsJson: '' })).toMatchObject({ ok: false })
    expect(await validateCustomScreenerNode({ ...VALID, columnsJson: '[]' })).toMatchObject({ ok: false })
  })

  it('全场景（含 300 根长序列）不命中 → 拒绝（2026-09-07 审查补强：无用过滤器闸门）', async () => {
    // guard 笔误形态：bars.length < 300 对全部样例（最长 300 根恰好不满足 < 300 之外
    // 全部 < 300）恒跳过——注意长序列恰 300 根，< 300 为 false……但最后 1 根才成立，
    // 299 根窗口仍可命中。用更直白的「永不命中」：close 恒为负的阈值。
    const result = await validateCustomScreenerNode({
      ...VALID,
      evaluateSource: `(bars) => {
        if (bars.length < 310) return null
        return { metrics: { mom: 1 }, reason: 'x' }
      }`,
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('全部样例场景')
  })

  it('短场景全 null 但长序列命中 → 放行（长窗口选股器合法形态）', async () => {
    // 窗口 200（above-ma 形态）：5 个短场景全 null，长序列命中。
    const result = await validateCustomScreenerNode({
      ...VALID,
      columnsJson: JSON.stringify([{ key: 'above', label: '倍数' }]),
      evaluateSource: `(bars) => {
        if (bars.length < 200) return null
        const close = bars[bars.length - 1].close
        const avg = bars.slice(-200).reduce((a, b) => a + b.close, 0) / 200
        if (!(close > avg)) return null
        return { metrics: { above: close / avg }, reason: '站上年线' }
      }`,
    })
    expect(result).toMatchObject({ ok: true })
  })
})

describe('applyScreenerManagement 名册合成', () => {
  it('覆盖原位替换、墓碑剔除、自定义追加', () => {
    const first = screenerParadigms[0]!
    const override: ScreenerDefinition = { ...first, name: '覆盖版' }
    const custom: ScreenerDefinition = { ...first, id: 'scr.custom-x', name: '自定义' }
    const roster = applyScreenerManagement(screenerParadigms, [override, custom], [screenerParadigms[1]!.id])
    expect(roster[0]!.name).toBe('覆盖版')
    expect(roster.some((d) => d.id === screenerParadigms[1]!.id)).toBe(false)
    expect(roster.at(-1)!.id).toBe('scr.custom-x')
  })
})

describe('screener_author / screener_delete / screener_reset（选股器管理）', () => {
  const VALID_SOURCE = `(bars) => {
    if (bars.length < 2) return null
    const mom = (bars[bars.length - 1].close - bars[0].close) / bars[0].close * 100
    if (mom <= 0) return null
    return { metrics: { mom }, reason: '动量为正' }
  }`
  const COLUMNS = JSON.stringify([{ key: 'mom', label: '动量' }])

  it('自定义选股器 author → 落盘；内置 id author → 覆盖 + 清墓碑', async () => {
    const store = createMemoryCustomScreenerStore()
    const tombstones = createMemoryBuiltinTombstonesStore()
    await tombstones.add('scr.rsi-oversold')
    const onWritten = vi.fn()
    const author = createScreenerAuthorTool({ store, tombstones, onWritten })

    const custom = await author.execute({ id: 'scr.custom-momentum', title: '动量', summary: 'x', columnsJson: COLUMNS, evaluateSource: VALID_SOURCE })
    expect(String(custom)).toContain('Successfully authored')
    expect(onWritten).toHaveBeenCalledTimes(1)

    const override = await author.execute({ id: 'scr.rsi-oversold', title: 'RSI 覆盖版', summary: 'x', columnsJson: COLUMNS, evaluateSource: VALID_SOURCE })
    expect(String(override)).toContain('screener_reset')
    expect(await tombstones.list()).toEqual([])
    expect(await store.get('scr.rsi-oversold')).toMatchObject({ title: 'RSI 覆盖版' })
  })

  it('delete：自定义移除 / 内置墓碑并丢弃覆盖；reset：恢复出厂', async () => {
    const store = createMemoryCustomScreenerStore()
    const tombstones = createMemoryBuiltinTombstonesStore()
    const author = createScreenerAuthorTool({ store, tombstones })
    const del = createScreenerDeleteTool({ store, tombstones })
    const reset = createScreenerResetTool({ store, tombstones })

    await author.execute({ id: 'scr.rsi-oversold', title: '覆盖版', summary: 'x', columnsJson: COLUMNS, evaluateSource: VALID_SOURCE })
    const deleted = JSON.parse(String(await del.execute({ id: 'scr.rsi-oversold' }))) as { scope: string; deleted: boolean }
    expect(deleted).toMatchObject({ scope: 'builtin', deleted: true })
    expect(await tombstones.list()).toEqual(['scr.rsi-oversold'])
    expect(await store.get('scr.rsi-oversold')).toBeUndefined()

    const resetResult = JSON.parse(String(await reset.execute({ id: 'scr.rsi-oversold' }))) as { changed: boolean }
    expect(resetResult.changed).toBe(true)
    expect(await tombstones.list()).toEqual([])

    // 自定义 id reset → 明确报错
    await expect(reset.execute({ id: 'scr.custom-momentum' })).rejects.toThrow('screener_delete')
  })

  it('file store remove(id, true)：选股器覆盖记录归档到 .archive.jsonl（2026-09-07 审查补强）', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createFileCustomScreenerStore } = await import('../src/custom-screener-fs.ts')
    const dir = await mkdtemp(join(tmpdir(), 'screeners-archive-'))
    const path = join(dir, 'custom-screeners.json')
    const store = createFileCustomScreenerStore(path)
    await store.save({
      id: 'scr.rsi-oversold', title: '旧覆盖', horizon: 'swing', summary: 'x',
      paramsJson: '[]', columnsJson: COLUMNS, evaluateSource: VALID_SOURCE, createdAt: 1,
    })
    expect(await store.remove('scr.rsi-oversold', true)).toBe(true)
    expect(await store.get('scr.rsi-oversold')).toBeUndefined()
    const { readFile } = await import('node:fs/promises')
    const archive = await readFile(`${path}.archive.jsonl`, 'utf8')
    expect(archive).toContain('"id":"scr.rsi-oversold"')
    expect(archive).toContain('旧覆盖')
  })
})
