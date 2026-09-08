/**
 * 自定义分组单测（issue #82，离线）：分组注册表 store（内存/文件）CRUD 与同名
 * 拒绝、行级 membership（assignGroup/stripGroup）语义、groups 字段落盘保真、
 * 并发 assign 串行化不丢更新。
 */
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createMemoryWatchlistGroupsStore,
  createMemoryWatchlistStore,
  newWatchlistGroupId,
  normalizeWatchlistRow,
} from '../src/index.ts'
import { createFileWatchlistGroupsStore, createFileWatchlistStore } from '../src/file-store.ts'

describe('normalizeWatchlistRow', () => {
  it('groups 空数组/坏项清洗成缺省键；合法 id 去重保序', () => {
    expect(normalizeWatchlistRow({ market: 'us', symbol: 'AAPL' })).toEqual({ market: 'us', symbol: 'AAPL' })
    expect(normalizeWatchlistRow({ market: 'us', symbol: 'AAPL', groups: [] })).toEqual({ market: 'us', symbol: 'AAPL' })
    expect(normalizeWatchlistRow({ market: 'us', symbol: 'AAPL', groups: ['g1', '', 3 as unknown as string, 'g1'] }))
      .toEqual({ market: 'us', symbol: 'AAPL', groups: ['g1'] })
  })
})

describe('memory stores（分组）', () => {
  it('分组注册表：create/rename/remove + 同名拒绝 + not-found', async () => {
    const store = createMemoryWatchlistGroupsStore()
    const created = await store.create('核心仓')
    expect(created.group?.name).toBe('核心仓')
    expect(await store.create('核心仓')).toEqual({ error: 'duplicate' })
    const renamed = await store.rename(created.group!.id, '观察仓')
    expect(renamed.group?.name).toBe('观察仓')
    expect(await store.rename('g_missing', 'x')).toEqual({ error: 'not-found' })
    // 改名撞别的组名也拒绝
    const second = await store.create('备选')
    expect((await store.rename(created.group!.id, '备选')).error).toBe('duplicate')
    expect(await store.remove(second.group!.id)).toBe(true)
    expect(await store.remove(second.group!.id)).toBe(false)
    expect((await store.list()).map(g => g.name)).toEqual(['观察仓'])
  })

  it('assignGroup：加入/移出/幂等/行缺席返回 false；stripGroup 清全表', async () => {
    const watchlists = createMemoryWatchlistStore()
    const groups = createMemoryWatchlistGroupsStore()
    const created = await groups.create('波段')
    const id = created.group?.id ?? newWatchlistGroupId()
    await watchlists.add('us', { market: 'us', symbol: 'AAPL', name: '苹果' })
    expect(await watchlists.assignGroup('us', 'AAPL', id, true)).toBe(true)
    expect(await watchlists.assignGroup('us', 'AAPL', id, true)).toBe(false) // 已在组内
    expect((await watchlists.list()).us?.[0]?.groups).toEqual([id])
    expect(await watchlists.assignGroup('us', 'MISSING', id, true)).toBe(false) // 行缺席
    expect(await watchlists.assignGroup('us', 'AAPL', id, false)).toBe(true)
    expect((await watchlists.list()).us?.[0]?.groups).toBeUndefined() // 清空后不落键

    await watchlists.assignGroup('us', 'AAPL', id, true)
    await watchlists.add('hk', { market: 'hk', symbol: '00700', groups: [id] })
    expect(await watchlists.stripGroup(id)).toBe(2)
    expect((await watchlists.list()).us?.[0]?.groups).toBeUndefined()
    expect((await watchlists.list()).hk?.[0]?.groups).toBeUndefined()
    expect(await watchlists.stripGroup(id)).toBe(0)
  })

  it('add 时携带 groups 直落行上（GUI 分组视图下添加标的语义）', async () => {
    const watchlists = createMemoryWatchlistStore()
    await watchlists.add('crypto', { market: 'crypto', symbol: 'BTCUSDT', groups: ['g_a', 'g_b'] })
    expect((await watchlists.list()).crypto?.[0]?.groups).toEqual(['g_a', 'g_b'])
    // 重复 add 不覆盖已有行的 groups
    await watchlists.add('crypto', { market: 'crypto', symbol: 'BTCUSDT' })
    expect((await watchlists.list()).crypto?.[0]?.groups).toEqual(['g_a', 'g_b'])
  })
})

describe('file stores（分组）', () => {
  it('分组注册表往返 + 跨实例持久化 + 无 tmp 残留', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-groups-'))
    const filePath = join(dir, 'watchlist-groups.json')
    const store = createFileWatchlistGroupsStore(filePath)
    const created = await store.create('总持仓')
    expect(created.group).toBeDefined()
    await store.rename(created.group!.id, '持仓观察')
    const reread = createFileWatchlistGroupsStore(filePath)
    const list = await reread.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('持仓观察')
    expect(await reread.remove(list[0]!.id)).toBe(true)
    expect(await createFileWatchlistGroupsStore(filePath).list()).toEqual([])
    const files = await readdir(dir)
    expect(files.filter(f => f.includes('.tmp.'))).toEqual([])
  })

  it('行 groups 字段落盘保真 + stripGroup 跨实例可见 + 并发 assign 不丢更新', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-groups-'))
    const filePath = join(dir, 'watchlists.json')
    const store = createFileWatchlistStore(filePath)
    await store.add('us', { market: 'us', symbol: 'AAPL', name: '苹果' })

    // 并发 assign 两个不同组：同队列串行化，双双落盘
    expect(await Promise.all([
      store.assignGroup('us', 'AAPL', 'g_1', true),
      store.assignGroup('us', 'AAPL', 'g_2', true),
    ])).toEqual([true, true])

    const reread = createFileWatchlistStore(filePath)
    expect((await reread.list()).us?.[0]?.groups).toEqual(['g_1', 'g_2'])

    expect(await reread.stripGroup('g_1')).toBe(1)
    expect((await createFileWatchlistStore(filePath).list()).us?.[0]?.groups).toEqual(['g_2'])
    const files = await readdir(dir)
    expect(files.filter(f => f.includes('.tmp.'))).toEqual([])
  })
})
