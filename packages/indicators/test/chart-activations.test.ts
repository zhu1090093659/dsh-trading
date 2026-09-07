/**
 * 图表激活名册（issue #63）：内存/文件 store、clamp/resolve 助手、
 * indicator_list / indicator_activate / indicator_deactivate 工具与
 * indicator_author 的「创作即上图」路径。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  clampActivationParams,
  createMemoryChartActivationStore,
  createMemoryCustomIndicatorStore,
  effectiveInstanceParams,
  resolveIndicatorSpec,
  sanitizeInstance,
  symbolScopeKey,
} from '../src/index.js'
import { createFileChartActivationStore } from '../src/chart-activations-fs.js'
import { createChartActivationTools } from '../src/chart-tools.js'
import { createAuthorIndicatorTool } from '../src/tool.js'

const CUSTOM_SOURCE = '(bars) => [{ key: "close_copy", kind: "line", color: "#ff0000", values: bars.map(b => b.close) }]'

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

describe('createMemoryChartActivationStore', () => {
  it('activate upsert：同 id 覆盖参数，每 id 至多一个实例', async () => {
    const store = createMemoryChartActivationStore()
    await store.activate({ id: 'ma', params: { n1: 5 } })
    await store.activate({ id: 'ma', params: { n1: 10 } })
    await store.activate({ id: 'macd', params: { fast: 12 } })
    const list = await store.list()
    expect(list).toEqual([
      { id: 'ma', params: { n1: 10 } },
      { id: 'macd', params: { fast: 12 } },
    ])
  })

  it('deactivate 返回是否确有实例；坏形实例被拒', async () => {
    const store = createMemoryChartActivationStore([{ id: 'rsi', params: { n: 14 } }])
    expect(await store.deactivate('rsi')).toBe(true)
    expect(await store.deactivate('rsi')).toBe(false)
    await expect(store.activate({ id: '', params: {} })).rejects.toThrow(/invalid instance shape/)
    await expect(store.activate({ id: 'x', params: { a: Number.NaN } })).rejects.toThrow(/invalid instance shape/)
  })

  it('replaceAll 全量替换（迁移导入路径）', async () => {
    const store = createMemoryChartActivationStore([{ id: 'ma', params: {} }])
    await store.replaceAll([{ id: 'kdj', params: { n: 9 } }, { id: 'bad-shape' }])
    expect(await store.list()).toEqual([{ id: 'kdj', params: { n: 9 } }])
  })
})

describe('clampActivationParams / resolveIndicatorSpec', () => {
  it('clamp：收敛 min/max + 取整，缺失键取默认，schema 外键丢弃', () => {
    const specs = [
      { key: 'n', label: 'N', default: 14, min: 2, max: 100 },
    ]
    expect(clampActivationParams(specs, { n: 999 })).toEqual({ n: 100 })
    expect(clampActivationParams(specs, { n: 1.6 })).toEqual({ n: 2 })
    expect(clampActivationParams(specs, {})).toEqual({ n: 14 })
    expect(clampActivationParams(specs, { n: 14, ghost: 5 })).toEqual({ n: 14 })
    expect(clampActivationParams(undefined, { a: 1, bad: Number.NaN })).toEqual({ a: 1 })
  })

  it('resolveIndicatorSpec：预置优先 → 自定义 store → 未知 undefined', async () => {
    const custom = createMemoryCustomIndicatorStore([{
      id: 'td9', title: 'TD9', pane: 'main',
      params: [{ key: 'count', label: '计数', default: 9, min: 5, max: 13 }],
      computeSource: CUSTOM_SOURCE, createdAt: 1,
    }])
    expect((await resolveIndicatorSpec('ma', custom))?.title).toBe('MA')
    expect(await resolveIndicatorSpec('td9', custom)).toMatchObject({ title: 'TD9', pane: 'main' })
    expect(await resolveIndicatorSpec('ghost', custom)).toBeUndefined()
  })
})

describe('symbolParams 按标的参数覆盖（issue #72）', () => {
  it('sanitizeInstance：保留合法 symbolParams，非法键/值清洗，坏形整体丢弃该字段', () => {
    expect(sanitizeInstance({ id: 'anchor_px', params: { a1: 0 }, symbolParams: { 'hk:00700.HK': { a1: 20240102, bad: Number.NaN } } }))
      .toEqual({ id: 'anchor_px', params: { a1: 0 }, symbolParams: { 'hk:00700.HK': { a1: 20240102 } } })
    expect(sanitizeInstance({ id: 'anchor_px', params: { a1: 0 }, symbolParams: { '': { a1: 1 }, 'hk:x': 'nope' } }))
      .toEqual({ id: 'anchor_px', params: { a1: 0 } })
    expect(sanitizeInstance({ id: 'anchor_px', params: { a1: 0 } })).toEqual({ id: 'anchor_px', params: { a1: 0 } })
    expect(sanitizeInstance({ id: '', params: {} })).toBeUndefined()
  })

  it('effectiveInstanceParams：命中覆盖整体替代，未命中/缺 market 回退全局', () => {
    const instance = { id: 'anchor_px', params: { a1: 0 }, symbolParams: { 'hk:00700.HK': { a1: 20240102 } } }
    expect(effectiveInstanceParams(instance, 'hk', '00700.HK')).toEqual({ a1: 20240102 })
    expect(effectiveInstanceParams(instance, 'hk', '02714.HK')).toEqual({ a1: 0 })
    expect(effectiveInstanceParams(instance)).toEqual({ a1: 0 })
    expect(effectiveInstanceParams(instance, 'hk')).toEqual({ a1: 0 })
    expect(symbolScopeKey('hk', '00700.HK')).toBe('hk:00700.HK')
  })

  it('内存 store：symbolParams 随 activate/list/replaceAll 保真深拷贝', async () => {
    const store = createMemoryChartActivationStore()
    const source = { a1: 20240102 }
    await store.activate({ id: 'anchor_px', params: { a1: 0 }, symbolParams: { 'hk:00700.HK': source } })
    source.a1 = 99999999 // 改源对象不得影响 store
    const listed = await store.list()
    expect(listed).toEqual([{ id: 'anchor_px', params: { a1: 0 }, symbolParams: { 'hk:00700.HK': { a1: 20240102 } } }])
    listed[0]?.symbolParams && (listed[0].symbolParams['hk:00700.HK']!.a1 = 1) // 改读出副本不得影响 store
    expect((await store.list())[0]?.symbolParams?.['hk:00700.HK']).toEqual({ a1: 20240102 })
  })

  it('文件 store：symbolParams 落盘读回一致', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-chart-sym-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'chart.json')
    const store = createFileChartActivationStore(file)
    await store.activate({ id: 'anchor_px', params: { a1: 0 }, symbolParams: { 'hk:00700.HK': { a1: 20240102 }, 'us:GOOGL': { a1: 20240315 } } })
    const reopened = createFileChartActivationStore(file)
    expect(await reopened.list()).toEqual([
      { id: 'anchor_px', params: { a1: 0 }, symbolParams: { 'hk:00700.HK': { a1: 20240102 }, 'us:GOOGL': { a1: 20240315 } } },
    ])
  })
})

describe('createFileChartActivationStore', () => {
  it('原子写读回一致；损坏文件降级空册', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-chart-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'chart.json')
    const store = createFileChartActivationStore(file)
    await store.activate({ id: 'ema', params: { n: 20 } })
    await store.deactivate('ghost')
    // 新实例从磁盘读回（绕开缓存直接开新 store）
    const reopened = createFileChartActivationStore(file)
    expect(await reopened.list()).toEqual([{ id: 'ema', params: { n: 20 } }])

    const corrupt = path.join(dir, 'corrupt.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(corrupt, '{not json', 'utf8')
    expect(await createFileChartActivationStore(corrupt).list()).toEqual([])
  })
})

describe('图表激活工具族（indicator_list / activate / deactivate）', () => {
  it('indicator_list：预置 + 自定义 + 激活名册一次给全', async () => {
    const customStore = createMemoryCustomIndicatorStore([{
      id: 'td9', title: 'TD9', pane: 'main', params: [],
      computeSource: CUSTOM_SOURCE, createdAt: 1, description: 'Tom DeMark 9',
    }])
    const chartStore = createMemoryChartActivationStore([{ id: 'ma', params: { n1: 5 } }])
    const { list } = createChartActivationTools({ customStore, chartStore })
    const out = JSON.parse(String(await list.execute({})))
    expect(out.presets.map((p: { id: string }) => p.id)).toContain('macd')
    expect(out.custom).toEqual([expect.objectContaining({ id: 'td9', description: 'Tom DeMark 9' })])
    expect(out.active).toEqual([{ id: 'ma', params: { n1: 5 } }])
  })

  it('indicator_activate：未知 id 拒绝并列可用集；paramsJson clamp', async () => {
    const customStore = createMemoryCustomIndicatorStore()
    const chartStore = createMemoryChartActivationStore()
    const { activate } = createChartActivationTools({ customStore, chartStore })
    await expect(activate.execute({ id: 'ghost' })).rejects.toThrow(/available ids/)
    const out = String(await activate.execute({ id: 'rsi', paramsJson: '{"n":999,"ghost":1}' }))
    expect(out).toContain('Mounted')
    expect(await chartStore.list()).toEqual([{ id: 'rsi', params: { n: 120 } }]) // RSI preset max=120
    expect(String(await activate.execute({ id: 'rsi', paramsJson: 'not-json' }))).toContain('not valid JSON')
  })

  it('indicator_activate：自定义 id 可挂载；同 id 重复挂载更新参数', async () => {
    const customStore = createMemoryCustomIndicatorStore([{
      id: 'td9', title: 'TD9', pane: 'main',
      params: [{ key: 'count', label: '计数', default: 9, min: 5, max: 13 }],
      computeSource: CUSTOM_SOURCE, createdAt: 1,
    }])
    const chartStore = createMemoryChartActivationStore()
    const { activate } = createChartActivationTools({ customStore, chartStore })
    expect(String(await activate.execute({ id: 'td9' }))).toContain('params: count=9')
    expect(String(await activate.execute({ id: 'td9', paramsJson: '{"count":11}' }))).toContain('count=11')
    expect(await chartStore.list()).toEqual([{ id: 'td9', params: { count: 11 } }])
  })

  it('indicator_activate 按标的覆盖（issue #72）：market+symbol 写 symbolParams，全局写保留覆盖', async () => {
    const customStore = createMemoryCustomIndicatorStore([{
      id: 'anchor_px', title: 'AnchoredPx', pane: 'main',
      params: [{ key: 'a1', label: '锚点1', default: 0, min: 0, max: 20991231 }],
      computeSource: CUSTOM_SOURCE, createdAt: 1,
    }])
    const chartStore = createMemoryChartActivationStore()
    const { activate } = createChartActivationTools({ customStore, chartStore })

    // market/symbol 只给一个 → 业务提示，不写入
    expect(String(await activate.execute({ id: 'anchor_px', market: 'hk' }))).toContain('supplied together')
    expect(await chartStore.list()).toEqual([])

    // 按标的写入两个覆盖，互不影响
    const out1 = String(await activate.execute({ id: 'anchor_px', market: 'hk', symbol: '00700.HK', paramsJson: '{"a1":20240102}' }))
    expect(out1).toContain('scope: hk:00700.HK')
    await activate.execute({ id: 'anchor_px', market: 'us', symbol: 'GOOGL', paramsJson: '{"a1":20240315}' })
    expect(await chartStore.list()).toEqual([{
      id: 'anchor_px', params: { a1: 0 },
      symbolParams: { 'hk:00700.HK': { a1: 20240102 }, 'us:GOOGL': { a1: 20240315 } },
    }])

    // 全局写：更新 params 但保留已有覆盖（回归：旧行为整体覆盖会抹掉 symbolParams）
    await activate.execute({ id: 'anchor_px', paramsJson: '{"a1":20250110}' })
    expect(await chartStore.list()).toEqual([{
      id: 'anchor_px', params: { a1: 20250110 },
      symbolParams: { 'hk:00700.HK': { a1: 20240102 }, 'us:GOOGL': { a1: 20240315 } },
    }])

    // 同标的重复写 → 覆盖该标的这套；另一标的保持
    await activate.execute({ id: 'anchor_px', market: 'hk', symbol: '00700.HK', paramsJson: '{"a1":20240620}' })
    expect((await chartStore.list())[0]?.symbolParams).toEqual({
      'hk:00700.HK': { a1: 20240620 }, 'us:GOOGL': { a1: 20240315 },
    })
  })

  it('indicator_deactivate：摘除后返回 removed，定义仍在库', async () => {
    const chartStore = createMemoryChartActivationStore([{ id: 'boll', params: {} }])
    const { deactivate } = createChartActivationTools({ chartStore })
    expect(JSON.parse(String(await deactivate.execute({ id: 'boll' })))).toMatchObject({ ok: true, removed: true })
    expect(JSON.parse(String(await deactivate.execute({ id: 'boll' })))).toMatchObject({ ok: true, removed: false })
    // required 缺失由 dsh-tools 框架校验拦截（execute 内同名校验为防御性冗余）。
    await expect(deactivate.execute({})).rejects.toThrow(/missing required property/)
  })

  it('emit 接线：activate/deactivate 回调经便捷工厂透传（回归：漏接导致 GUI 不实时）', async () => {
    const onWritten = vi.fn()
    const onDeleted = vi.fn()
    const tools = createChartActivationTools({ chartStore: createMemoryChartActivationStore(), onWritten, onDeleted })
    await tools.activate.execute({ id: 'ma' })
    expect(onWritten).toHaveBeenCalledTimes(1)
    await tools.deactivate.execute({ id: 'ma' })
    expect(onDeleted).toHaveBeenCalledWith('ma', true)
  })
})

describe('indicator_author「创作即上图」（issue #63）', () => {
  const AUTHOR_ARGS = {
    id: 'authored_i',
    title: 'Authored',
    pane: 'sub',
    computeSource: CUSTOM_SOURCE,
  }

  it('activate: true → 校验通过后按 schema 默认参数上图', async () => {
    const store = createMemoryCustomIndicatorStore()
    const chartStore = createMemoryChartActivationStore()
    const tool = createAuthorIndicatorTool({ store, chartStore })
    const out = String(await tool.execute({ ...AUTHOR_ARGS, activate: true }))
    expect(out).toContain('mounted on the chart')
    expect(await chartStore.list()).toEqual([{ id: 'authored_i', params: {} }])
  })

  it('re-author activate:true 保留 symbolParams 并按新 schema 重 clamp（issue #72 复审：不抹覆盖、stale 覆盖不直通）', async () => {
    const store = createMemoryCustomIndicatorStore()
    const chartStore = createMemoryChartActivationStore()
    const tool = createAuthorIndicatorTool({ store, chartStore })
    const v1 = { ...AUTHOR_ARGS, paramsJson: '[{"key":"a1","label":"锚点1","default":0,"min":0,"max":20991231}]' }

    // v1 挂载并写一个按标的覆盖
    await tool.execute({ ...v1, activate: true })
    await chartStore.activate({ id: 'authored_i', params: { a1: 0 }, symbolParams: { 'hk:00700.HK': { a1: 20240102 } } })

    // v2 改 schema（a1 → a2）：重挂不清覆盖；覆盖按新 schema 重 clamp（旧键 a1 丢弃、
    // 缺键 a2 补默认 7），全局 params 取新 schema 默认值。
    const v2 = { ...AUTHOR_ARGS, paramsJson: '[{"key":"a2","label":"锚点2","default":7,"min":0,"max":100}]' }
    await tool.execute({ ...v2, activate: true })
    expect(await chartStore.list()).toEqual([{
      id: 'authored_i', params: { a2: 7 },
      symbolParams: { 'hk:00700.HK': { a2: 7 } },
    }])

    // v3 同 schema re-author：覆盖原样保留，全局 params 更新为新默认。
    const v3 = { ...AUTHOR_ARGS, paramsJson: '[{"key":"a2","label":"锚点2","default":9,"min":0,"max":100}]' }
    await tool.execute({ ...v3, activate: true })
    expect(await chartStore.list()).toEqual([{
      id: 'authored_i', params: { a2: 9 },
      symbolParams: { 'hk:00700.HK': { a2: 7 } },
    }])
  })

  it('activate 缺省 → 不上图；chartStore 缺席 → 降级说明不失败', async () => {
    const store = createMemoryCustomIndicatorStore()
    const chartStore = createMemoryChartActivationStore()
    const withStore = createAuthorIndicatorTool({ store, chartStore })
    expect(String(await withStore.execute({ ...AUTHOR_ARGS }))).not.toContain('mounted')
    expect(await chartStore.list()).toEqual([])

    const noChart = createAuthorIndicatorTool({ store })
    const out = String(await noChart.execute({ ...AUTHOR_ARGS, activate: true }))
    expect(out).toContain('no chart activation store is available')
    expect(await store.get('authored_i')).toBeDefined()
  })

  it('onActivated 回调：创作即上图成功后触发（emit 接线点；缺省上图不触发）', async () => {
    const store = createMemoryCustomIndicatorStore()
    const chartStore = createMemoryChartActivationStore()
    const onActivated = vi.fn()
    await createAuthorIndicatorTool({ store, chartStore, onActivated }).execute({ ...AUTHOR_ARGS, activate: true })
    expect(onActivated).toHaveBeenCalledTimes(1)
    expect(onActivated).toHaveBeenCalledWith('authored_i')

    const silent = vi.fn()
    await createAuthorIndicatorTool({ store, chartStore, onActivated: silent }).execute({ ...AUTHOR_ARGS, id: 'authored_ii' })
    expect(silent).not.toHaveBeenCalled()
  })
})