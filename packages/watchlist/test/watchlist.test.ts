/**
 * watchlist 包单测（离线）：内存/file store 往返、原子写无残留、4 工具链
 * （list/add 去重/remove/select 名称解析）、事件回调接线。
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { instrumentFormOf } from '@dshtrading/api'
import { createMemorySelectionStore, createMemoryWatchlistStore } from '../src/index.ts'
import { createFileSelectionStore, createFileWatchlistStore } from '../src/file-store.ts'
import { WATCHLIST_SEEDS } from '../src/seeds.ts'
import {
  createWatchlistAddTool,
  createWatchlistListTool,
  createWatchlistRemoveTool,
  createWatchlistSelectTool,
  type WatchlistToolDeps,
} from '../src/plugin.ts'

function makeDeps() {
  const watchlists = createMemoryWatchlistStore()
  const selection = createMemorySelectionStore()
  const onWatchlistsChanged = vi.fn()
  const onSelectionChanged = vi.fn()
  const deps: WatchlistToolDeps = { watchlists, selection, onWatchlistsChanged, onSelectionChanged }
  return { deps, watchlists, selection, onWatchlistsChanged, onSelectionChanged }
}

describe('memory stores', () => {
  it('add 按 symbol 去重；remove 返回 existed；save 全量替换', async () => {
    const store = createMemoryWatchlistStore()
    expect(await store.add('crypto', { market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin' })).toBe(true)
    expect(await store.add('crypto', { market: 'crypto', symbol: 'BTCUSDT' })).toBe(false)
    expect(await store.add('us', { market: 'us', symbol: 'AAPL', name: '苹果' })).toBe(true)
    expect(await store.remove('crypto', 'BTCUSDT')).toBe(true)
    expect(await store.remove('crypto', 'BTCUSDT')).toBe(false)
    await store.save({ hk: [{ market: 'hk', symbol: '00700' }] })
    expect(await store.list()).toEqual({ hk: [{ market: 'hk', symbol: '00700' }] })
  })
})

describe('file stores（原子写）', () => {
  it('watchlist 往返 + 跨实例持久化 + 无 tmp 残留', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'watchlists.json')
    const store = createFileWatchlistStore(filePath)
    await store.add('crypto', { market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin' })
    const reread = createFileWatchlistStore(filePath)
    expect(await reread.list()).toEqual({ crypto: [{ market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin' }] })
    const files = await readdir(dir)
    expect(files.filter(f => f.includes('.tmp.'))).toEqual([])
  })

  it('selection 往返 + null 覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'selection.json')
    const store = createFileSelectionStore(filePath)
    await store.set({ instrument: { market: 'us', symbol: 'AAPL', name: '苹果' } })
    const reread = createFileSelectionStore(filePath)
    expect(await reread.get()).toEqual({ instrument: { market: 'us', symbol: 'AAPL', name: '苹果' } })
    await reread.set({ instrument: null })
    expect(await reread.get()).toEqual({ instrument: null })
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    expect(parsed).toEqual({ instrument: null })
  })
})

describe('watchlist_* tools', () => {
  it('watchlist_list：空库也回落种子行（合并视图，与 GUI 左栏一致），sources 标注来源', async () => {
    const { deps } = makeDeps()
    const tool = createWatchlistListTool(deps)
    const empty = JSON.parse(String(await tool.execute({}))) as {
      total: number
      markets: string[]
      sources: Record<string, 'custom' | 'seed'>
      watchlists: Record<string, Array<{ market: string; symbol: string; name?: string }>>
    }
    // 全空 host store → 4 个市场全部回落种子展示行。
    expect(empty.markets).toEqual(['crypto', 'us', 'cn', 'hk'])
    expect(empty.total).toBe(14)
    expect(Object.values(empty.sources).every(source => source === 'seed')).toBe(true)
    expect(empty.watchlists.us[0]).toEqual({ market: 'us', symbol: 'AAPL', name: '苹果' })

    await createWatchlistAddTool(deps).execute({ market: 'us', symbol: 'AAPL', name: '苹果' })
    const wire = JSON.parse(String(await tool.execute({}))) as {
      total: number
      sources: Record<string, 'custom' | 'seed'>
      watchlists: Record<string, Array<{ symbol: string }>>
    }
    // 定制后该市场以用户行为准（不再混入种子），来源翻 custom；行内容不变。
    expect(wire.sources.us).toBe('custom')
    expect(wire.sources.crypto).toBe('seed')
    expect(wire.watchlists.us).toEqual([{ market: 'us', symbol: 'AAPL', name: '苹果' }])
    // crypto 4 + us 1（定制后种子被抑制）+ cn 3 + hk 3。
    expect(wire.total).toBe(11)
  })

  it('watchlist_add：去重 + 事件回调仅在实际新增时触发', async () => {
    const { deps, onWatchlistsChanged } = makeDeps()
    const tool = createWatchlistAddTool(deps)
    const first = await tool.execute({ market: 'us', symbol: 'AAPL' })
    expect(first.added).toBe(true)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)
    const second = await tool.execute({ market: 'us', symbol: 'AAPL' })
    expect(second.added).toBe(false)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)
  })

  it('watchlist_add：缺 market → schema 层拒绝（required property）', async () => {
    const { deps } = makeDeps()
    await expect(createWatchlistAddTool(deps).execute({ symbol: 'AAPL' })).rejects.toThrow(/missing required property/)
  })

  it('watchlist_remove：移除 + 事件回调', async () => {
    const { deps, onWatchlistsChanged } = makeDeps()
    await createWatchlistAddTool(deps).execute({ market: 'us', symbol: 'AAPL' })
    onWatchlistsChanged.mockClear()
    const wire = await createWatchlistRemoveTool(deps).execute({ market: 'us', symbol: 'AAPL' })
    expect(wire.removed).toBe(true)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)
  })

  it('watchlist_remove：未定制状态下可直接删除默认种子标的，剩余种子物化为 custom', async () => {
    const { deps, onWatchlistsChanged } = makeDeps()
    const removeTool = createWatchlistRemoveTool(deps)
    const listTool = createWatchlistListTool(deps)

    // 删除前：全部为 seed
    const before = JSON.parse(String(await listTool.execute({}))) as {
      sources: Record<string, string>
      watchlists: Record<string, Array<{ symbol: string }>>
    }
    expect(before.sources.us).toBe('seed')
    expect(before.watchlists.us.map(r => r.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA', 'GOOGL'])

    // 空库未定制状态下，直接删除 AAPL
    const wire = await removeTool.execute({ market: 'us', symbol: 'AAPL' })
    expect(wire.removed).toBe(true)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)

    // 删除后：us 变为 custom，剩余 3 行（MSFT, NVDA, GOOGL）
    const after = JSON.parse(String(await listTool.execute({}))) as {
      sources: Record<string, string>
      watchlists: Record<string, Array<{ symbol: string }>>
    }
    expect(after.sources.us).toBe('custom')
    expect(after.watchlists.us.map(r => r.symbol)).toEqual(['MSFT', 'NVDA', 'GOOGL'])

    // 删除不存在的 symbol：返回 removed: false
    const notFound = await removeTool.execute({ market: 'us', symbol: 'NONEXISTENT' })
    expect(notFound.removed).toBe(false)
  })

  it('watchlist_remove：删光默认自选后保持空列表，不复活种子', async () => {
    const { deps } = makeDeps()
    const removeTool = createWatchlistRemoveTool(deps)
    const listTool = createWatchlistListTool(deps)

    // 陆续删光 cn 市场的 3 只默认股票
    await removeTool.execute({ market: 'cn', symbol: '600519' })
    await removeTool.execute({ market: 'cn', symbol: '000001' })
    await removeTool.execute({ market: 'cn', symbol: '601318' })

    const list = JSON.parse(String(await listTool.execute({}))) as {
      sources: Record<string, string>
      watchlists: Record<string, Array<{ symbol: string }>>
    }
    expect(list.sources.cn).toBe('custom')
    expect(list.watchlists.cn).toEqual([])
  })

  it('watchlist_select：自选行名称复用；种子行同名解析；未知 symbol 以裸 symbol 兜底；触发 selection 事件', async () => {
    const { deps, selection, onSelectionChanged } = makeDeps()
    await createWatchlistAddTool(deps).execute({ market: 'cn', symbol: '600519', name: '贵州茅台' })
    const named = JSON.parse(String(await createWatchlistSelectTool(deps).execute({ market: 'cn', symbol: '600519' }))) as { selected: { name?: string } }
    expect(named.selected.name).toBe('贵州茅台')
    // 种子行（host store 无行）：合并视图解析出展示名（与 watchlist_list 一致）。
    const seeded = JSON.parse(String(await createWatchlistSelectTool(deps).execute({ market: 'hk', symbol: '00700' }))) as { selected: { name?: string } }
    expect(seeded.selected).toEqual({ market: 'hk', symbol: '00700', name: '腾讯控股' })
    const unknown = JSON.parse(String(await createWatchlistSelectTool(deps).execute({ market: 'hk', symbol: '09999' }))) as { selected: { name?: string } }
    expect(unknown.selected).toEqual({ market: 'hk', symbol: '09999' })
    expect((await selection.get()).instrument).toEqual({ market: 'hk', symbol: '09999' })
    expect(onSelectionChanged).toHaveBeenCalledTimes(3)
  })
})

describe('形态元数据（2026-10-08 加密永续 P5）', () => {
  it('用户查看默认自选种子时，种子行按唯一判据全是现货（默认首屏不因永续支持而变）', () => {
    // Given: 种子表（seeds.ts）是默认首屏的单一事实源
    const seeds = WATCHLIST_SEEDS
    // When: 逐市场逐行按 is-symbol-form 判据复核
    const mismatched = Object.entries(seeds).flatMap(([market, list]) =>
      list.filter(row => row.market !== market || instrumentFormOf(row.symbol) !== 'spot'))
    // Then: 没有一行是永续（-SWAP），且桶键与行 market 一致
    expect(mismatched).toEqual([])
    expect(Object.values(seeds).flat()).toHaveLength(14)
  })

  it('用户添加带形态元数据的行时，内存 store 保真；不带元数据的现货行形状不变', async () => {
    // Given: 空内存自选
    const store = createMemoryWatchlistStore()
    // When: 添加一行 TradFi 永续（带交易所元数据）与一行纯现货
    await store.add('crypto', { market: 'crypto', symbol: 'TSLAUSDT-SWAP', name: '特斯拉 永续', form: 'perp', assetClass: 'equity' })
    await store.add('crypto', { market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin' })
    // Then: 永续行保真 form/assetClass；现货行不落这两键（缺省即现货）
    const rows = (await store.list()).crypto ?? []
    expect(rows[0]).toEqual({ market: 'crypto', symbol: 'TSLAUSDT-SWAP', name: '特斯拉 永续', form: 'perp', assetClass: 'equity' })
    expect(rows[1]).toEqual({ market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin' })
  })

  it('用户添加永续行后刷新（新实例读盘），形态与资产类别仍在（文件 store 保真）', async () => {
    // Given: 文件自选 store
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'watchlists.json')
    // When: 添加一行大宗永续并新建实例重读
    await createFileWatchlistStore(filePath).add('crypto', { market: 'crypto', symbol: 'XAUUSDT-SWAP', form: 'perp', assetClass: 'commodity' })
    const reread = await createFileWatchlistStore(filePath).list()
    // Then: 盘上行保真（元数据不因往返丢失）
    expect(reread.crypto).toEqual([{ market: 'crypto', symbol: 'XAUUSDT-SWAP', form: 'perp', assetClass: 'commodity' }])
  })

  it('用户用 watchlist_select 选中永续自选行时，选中记录带形态（agent 面与 GUI 同源）', async () => {
    // Given: 自选里有一行 TradFi 永续
    const { deps, watchlists, selection } = makeDeps()
    await watchlists.add('crypto', { market: 'crypto', symbol: 'TSLAUSDT-SWAP', name: '特斯拉 永续', form: 'perp', assetClass: 'equity' })
    // When: watchlist_select 选中它
    const wire = JSON.parse(String(await createWatchlistSelectTool(deps).execute({ market: 'crypto', symbol: 'TSLAUSDT-SWAP' }))) as { selected: { form?: string; assetClass?: string } }
    // Then: 选中记录（中栏切图的输入）保留形态与资产类别
    expect(wire.selected.form).toBe('perp')
    expect(wire.selected.assetClass).toBe('equity')
    expect((await selection.get()).instrument?.assetClass).toBe('equity')
  })
})

describe('file store 并发读改写（issue #58）', () => {
  it('并发 add 全部落盘不丢更新（RMW 全程入队串行化）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'watchlists.json')
    const store = createFileWatchlistStore(filePath)
    const results = await Promise.all([
      store.add('us', { market: 'us', symbol: 'AAPL' }),
      store.add('us', { market: 'us', symbol: 'NVDA' }),
      store.add('us', { market: 'us', symbol: 'MSFT' }),
      store.add('crypto', { market: 'crypto', symbol: 'BTCUSDT' }),
    ])
    expect(results).toEqual([true, true, true, true])
    // 新实例（空缓存）从盘上读：修复前最后一个 flush 用旧态整行覆盖，先写行丢失。
    const reread = createFileWatchlistStore(filePath)
    const list = await reread.list()
    expect(list.us?.map(r => r.symbol).sort()).toEqual(['AAPL', 'MSFT', 'NVDA'])
    expect(list.crypto?.map(r => r.symbol)).toEqual(['BTCUSDT'])
    const files = await readdir(dir)
    expect(files.filter(f => f.includes('.tmp.'))).toEqual([])
  })

  it('并发 add 同一 symbol 仍按去重语义只落一行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'watchlists.json')
    const store = createFileWatchlistStore(filePath)
    const results = await Promise.all([
      store.add('us', { market: 'us', symbol: 'AAPL' }),
      store.add('us', { market: 'us', symbol: 'AAPL' }),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const list = await store.list()
    expect(list.us).toHaveLength(1)
  })

  it('file store 空文件下直接 remove 默认种子标的持久化落盘，新实例可见定制', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-'))
    const filePath = join(dir, 'watchlists.json')
    const store = createFileWatchlistStore(filePath)

    // 空文件下直接从 us 删 AAPL
    const removed = await store.remove('us', 'AAPL')
    expect(removed).toBe(true)

    // 新实例重读：us 应包含剩余 3 只股票
    const reread = createFileWatchlistStore(filePath)
    const list = await reread.list()
    expect(list.us?.map(r => r.symbol)).toEqual(['MSFT', 'NVDA', 'GOOGL'])
  })
})

