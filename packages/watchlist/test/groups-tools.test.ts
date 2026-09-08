/**
 * 自选分组 Agent 工具单测（issue #86 / 审计缺口卡 G5，离线）：
 * 分组 CRUD、行级归属（含种子行物化）、删组连带语义（清成员不删行）、
 * watchlist_list 的 groups/selection 回显、事件回调接线。
 */
import { describe, expect, it, vi } from 'vitest'
import { createMemorySelectionStore, createMemoryWatchlistGroupsStore, createMemoryWatchlistStore } from '../src/index.ts'
import {
  createWatchlistGroupAssignTool,
  createWatchlistGroupCreateTool,
  createWatchlistGroupDeleteTool,
  createWatchlistGroupRenameTool,
  createWatchlistListTool,
  createWatchlistAddTool,
  type WatchlistToolDeps,
} from '../src/plugin.ts'

function makeDeps() {
  const watchlists = createMemoryWatchlistStore()
  const selection = createMemorySelectionStore()
  const groups = createMemoryWatchlistGroupsStore()
  const onWatchlistsChanged = vi.fn()
  const onSelectionChanged = vi.fn()
  const deps: WatchlistToolDeps = { watchlists, selection, groups, onWatchlistsChanged, onSelectionChanged }
  return { deps, watchlists, selection, groups, onWatchlistsChanged, onSelectionChanged }
}

type ListWire = {
  ok: boolean
  groups: Array<{ id: string; name: string; createdAt: number; members: number }>
  selection: { market: string; symbol: string; name?: string } | null
  watchlists: Record<string, Array<{ symbol: string; groups?: string[] }>>
}

describe('watchlist_group_create', () => {
  it('创建成功返回 id/name 并 emit watchlists；同名拒绝为 ok:false + code duplicate', async () => {
    const { deps, onWatchlistsChanged } = makeDeps()
    const tool = createWatchlistGroupCreateTool(deps)
    const created = JSON.parse(String(await tool.execute({ name: '港股观察' }))) as { ok: boolean; id: string; name: string }
    expect(created.ok).toBe(true)
    expect(created.name).toBe('港股观察')
    expect(created.id).toMatch(/^g_/)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)

    const dup = JSON.parse(String(await tool.execute({ name: '港股观察' }))) as { ok: boolean; code: string }
    expect(dup).toMatchObject({ ok: false, code: 'duplicate' })
    // 拒绝路径不改状态、不 emit。
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)
  })

  it('名称为空 / 超 24 字符 → 抛错（schema 之外的业务校验）', async () => {
    const { deps } = makeDeps()
    const tool = createWatchlistGroupCreateTool(deps)
    await expect(tool.execute({ name: '   ' })).rejects.toThrow(/name is required/)
    await expect(tool.execute({ name: 'x'.repeat(25) })).rejects.toThrow(/too long/)
  })

  it('分组 store 缺席（老部署）→ 响亮报错，不静默假装成功', async () => {
    const { deps } = makeDeps()
    const tool = createWatchlistGroupCreateTool({ watchlists: deps.watchlists, selection: deps.selection })
    await expect(tool.execute({ name: 'x' })).rejects.toThrow(/group store is not mounted/)
  })
})

describe('watchlist_group_rename / _delete', () => {
  it('rename 回显 from → to；未知 id 与同名冲突各自拒绝', async () => {
    const { deps, onWatchlistsChanged } = makeDeps()
    const create = createWatchlistGroupCreateTool(deps)
    const a = JSON.parse(String(await create.execute({ name: '核心仓' }))) as { id: string }
    await create.execute({ name: '备选' })

    const renamed = JSON.parse(String(await createWatchlistGroupRenameTool(deps).execute({ id: a.id, name: '长线仓' }))) as {
      ok: boolean; from: string; to: string
    }
    expect(renamed).toMatchObject({ ok: true, from: '核心仓', to: '长线仓' })

    const notFound = JSON.parse(String(await createWatchlistGroupRenameTool(deps).execute({ id: 'g_missing', name: 'x' }))) as { ok: boolean; code: string }
    expect(notFound).toMatchObject({ ok: false, code: 'not-found' })
    const dup = JSON.parse(String(await createWatchlistGroupRenameTool(deps).execute({ id: a.id, name: '备选' }))) as { ok: boolean; code: string }
    expect(dup).toMatchObject({ ok: false, code: 'duplicate' })
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(3) // create 两次 + rename 一次
  })

  it('delete 清成员但保留自选行；未知 id 拒绝；回显 membersCleared', async () => {
    const { deps, watchlists, onWatchlistsChanged } = makeDeps()
    const created = JSON.parse(String(await createWatchlistGroupCreateTool(deps).execute({ name: '波段' }))) as { id: string }
    await createWatchlistAddTool(deps).execute({ market: 'us', symbol: 'AAPL', name: '苹果' })
    await createWatchlistGroupAssignTool(deps).execute({ id: created.id, market: 'us', symbol: 'AAPL', member: true })

    const deleted = JSON.parse(String(await createWatchlistGroupDeleteTool(deps).execute({ id: created.id }))) as {
      ok: boolean; name: string; removed: boolean; membersCleared: number
    }
    expect(deleted).toMatchObject({ ok: true, name: '波段', removed: true, membersCleared: 1 })
    // 行还在，只是归属被摘掉。
    expect(await watchlists.list()).toEqual({ us: [{ market: 'us', symbol: 'AAPL', name: '苹果' }] })
    expect(await deps.groups!.list()).toEqual([])
    expect(onWatchlistsChanged).toHaveBeenCalled()

    const again = JSON.parse(String(await createWatchlistGroupDeleteTool(deps).execute({ id: created.id }))) as { ok: boolean; code: string }
    expect(again).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('watchlist_group_assign', () => {
  it('加入/移出/幂等；未知分组 id 拒绝（不留悬挂归属）', async () => {
    const { deps, watchlists, onWatchlistsChanged } = makeDeps()
    const created = JSON.parse(String(await createWatchlistGroupCreateTool(deps).execute({ name: '港股' }))) as { id: string }
    await createWatchlistAddTool(deps).execute({ market: 'hk', symbol: '00700', name: '腾讯控股' })
    onWatchlistsChanged.mockClear()

    const assign = createWatchlistGroupAssignTool(deps)
    const added = JSON.parse(String(await assign.execute({ id: created.id, market: 'hk', symbol: '00700', member: true }))) as {
      ok: boolean; assigned: boolean; removed: boolean; materialized: boolean
    }
    expect(added).toMatchObject({ ok: true, assigned: true, removed: false, materialized: false })
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)

    const again = JSON.parse(String(await assign.execute({ id: created.id, market: 'hk', symbol: '00700', member: true }))) as { assigned: boolean }
    expect(again.assigned).toBe(false)
    expect(onWatchlistsChanged).toHaveBeenCalledTimes(1)

    const removed = JSON.parse(String(await assign.execute({ id: created.id, market: 'hk', symbol: '00700', member: false }))) as { removed: boolean }
    expect(removed.removed).toBe(true)
    expect((await watchlists.list()).hk?.[0]?.groups).toBeUndefined()

    const unknown = JSON.parse(String(await assign.execute({ id: 'g_missing', market: 'hk', symbol: '00700', member: true }))) as { ok: boolean; code: string }
    expect(unknown).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('未定制市场：整体物化种子基线后写归属（materialized=true，其余种子行不丢）', async () => {
    const { deps, watchlists } = makeDeps()
    const created = JSON.parse(String(await createWatchlistGroupCreateTool(deps).execute({ name: '港股' }))) as { id: string }
    const wire = JSON.parse(String(await createWatchlistGroupAssignTool(deps).execute({
      id: created.id, market: 'hk', symbol: '00700', member: true, name: '腾讯控股',
    }))) as { materialized: boolean; assigned: boolean }
    expect(wire).toMatchObject({ materialized: true, assigned: true })

    const rows = (await watchlists.list()).hk ?? []
    // 种子基线整体物化（hk 3 行）+ 目标行本来就在种子里 → 不重复追加。
    expect(rows.map(row => row.symbol)).toEqual(['00700', '09988', '03690'])
    expect(rows.find(row => row.symbol === '00700')?.groups).toEqual([created.id])
  })

  it('缺 member → schema 层拒绝（required property）', async () => {
    const { deps } = makeDeps()
    const created = JSON.parse(String(await createWatchlistGroupCreateTool(deps).execute({ name: 'x' }))) as { id: string }
    await expect(createWatchlistGroupAssignTool(deps).execute({ id: created.id, market: 'us', symbol: 'AAPL' }))
      .rejects.toThrow(/missing required property/)
  })
})

describe('watchlist_list 回显 groups / selection', () => {
  it('分组带成员数、选中态回显；无分组无选中时为空数组 / null', async () => {
    const { deps, selection } = makeDeps()
    const empty = JSON.parse(String(await createWatchlistListTool(deps).execute({}))) as ListWire
    expect(empty.groups).toEqual([])
    expect(empty.selection).toBeNull()

    const created = JSON.parse(String(await createWatchlistGroupCreateTool(deps).execute({ name: '核心仓' }))) as { id: string }
    await createWatchlistGroupAssignTool(deps).execute({ id: created.id, market: 'us', symbol: 'AAPL', member: true })
    await selection.set({ instrument: { market: 'us', symbol: 'AAPL', name: '苹果' } })

    const wire = JSON.parse(String(await createWatchlistListTool(deps).execute({}))) as ListWire
    expect(wire.groups).toEqual([{ id: created.id, name: '核心仓', createdAt: expect.any(Number), members: 1 }])
    expect(wire.selection).toEqual({ market: 'us', symbol: 'AAPL', name: '苹果' })
  })
})
