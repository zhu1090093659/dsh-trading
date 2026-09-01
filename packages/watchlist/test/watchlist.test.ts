/**
 * watchlist 包单测（离线）：内存/file store 往返、原子写无残留、4 工具链
 * （list/add 去重/remove/select 名称解析）、事件回调接线。
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMemorySelectionStore, createMemoryWatchlistStore } from '../src/index.ts'
import { createFileSelectionStore, createFileWatchlistStore } from '../src/file-store.ts'
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
  it('watchlist_list：空库 / 有行两种形态', async () => {
    const { deps } = makeDeps()
    const tool = createWatchlistListTool(deps)
    const empty = JSON.parse(String(await tool.execute({}))) as { total: number }
    expect(empty.total).toBe(0)

    await createWatchlistAddTool(deps).execute({ market: 'us', symbol: 'AAPL', name: '苹果' })
    const wire = JSON.parse(String(await tool.execute({}))) as { total: number; markets: string[] }
    expect(wire.total).toBe(1)
    expect(wire.markets).toEqual(['us'])
  })

  it('watchlist_add：去重 + 事件回调仅在实际新增时触发', async () => {
    const { deps, onWatchlistsChanged } = makeDeps()
    const tool = createWatchlistAddTool(deps)
    const first = JSON.parse(String(await tool.execute({ market: 'us', symbol: 'AAPL' }))) as { added: boolean }
    expect(first.added).toBe(true)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)
    const second = JSON.parse(String(await tool.execute({ market: 'us', symbol: 'AAPL' }))) as { added: boolean }
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
    const wire = JSON.parse(String(await createWatchlistRemoveTool(deps).execute({ market: 'us', symbol: 'AAPL' }))) as { removed: boolean }
    expect(wire.removed).toBe(true)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)
  })

  it('watchlist_select：自选行名称复用；未知 symbol 以裸 symbol 兜底；触发 selection 事件', async () => {
    const { deps, selection, onSelectionChanged } = makeDeps()
    await createWatchlistAddTool(deps).execute({ market: 'cn', symbol: '600519', name: '贵州茅台' })
    const named = JSON.parse(String(await createWatchlistSelectTool(deps).execute({ market: 'cn', symbol: '600519' }))) as { selected: { name?: string } }
    expect(named.selected.name).toBe('贵州茅台')
    const unknown = JSON.parse(String(await createWatchlistSelectTool(deps).execute({ market: 'hk', symbol: '00700' }))) as { selected: { name?: string } }
    expect(unknown.selected).toEqual({ market: 'hk', symbol: '00700' })
    expect((await selection.get()).instrument).toEqual({ market: 'hk', symbol: '00700' })
    expect(onSelectionChanged).toHaveBeenCalledTimes(2)
  })
})
