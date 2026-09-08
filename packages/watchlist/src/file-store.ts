/**
 * 文件持久化版自选/选中 store（Node.js 宿主侧使用，tmp+rename 原子写，
 * indicators/custom-fs 同款模式——issue #32 规格）。
 */
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SelectionRecord, SelectionStore, WatchlistGroup, WatchlistGroupsStore, WatchlistGroupWriteResult, WatchlistStore, WatchlistsMap } from './index.ts'
import { newWatchlistGroupId, normalizeWatchlistRow } from './index.ts'
import { WATCHLIST_SEEDS } from './seeds.ts'

/**
 * 跨平台健壮原子写入：rename 遇 Windows EPERM/EBUSY（目标被占用）短暂退避重试；
 * 重试耗尽或任何失败一律保留旧文件、清理 tmp、log + throw——目标文件永远只被
 * 原子 rename 触碰，绝不非原子直写（防止半截写损坏 JSON 导致 load 静默重置）。
 */
async function safeAtomicWrite(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath)
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tmpPath, data, 'utf8')
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rename(tmpPath, filePath)
        return
      } catch (err: any) {
        if (err?.code !== 'EPERM' && err?.code !== 'EBUSY') throw err
        lastError = err
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
    throw lastError
  } catch (error) {
    console.error(`[dsh-trading/watchlist] failed to atomic flush watchlists to ${filePath}:`, error)
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

export function createFileWatchlistStore(filePath: string): WatchlistStore {
  let cache: WatchlistsMap | null = null
  let pendingWrite = Promise.resolve()

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pendingWrite.then(fn, fn)
    pendingWrite = next.then(() => {}, () => {})
    return next
  }

  async function load(): Promise<WatchlistsMap> {
    if (cache !== null) return cache
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content) as WatchlistsMap
      cache = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/watchlist] failed to read watchlists from ${filePath}:`, err)
      }
      cache = {}
    }
    return cache
  }

  /** 仅在 enqueue 队列内调用：写盘不能二次入队（外层已持队，内层 enqueue 会自等死锁）。 */
  function writeNow(map: WatchlistsMap): Promise<void> {
    return safeAtomicWrite(filePath, JSON.stringify(map, null, 2))
  }

  async function flush(map: WatchlistsMap): Promise<void> {
    return enqueue(async () => {
      await writeNow(map)
    })
  }

  return {
    async list() {
      return { ...(await load()) }
    },
    async save(next) {
      cache = { ...next }
      await flush(cache)
    },
    // 读改写全程入队串行化（issue #58）：此前只有写盘排队，两个并发 add 都从
    // 同一旧态计算 next，后写覆盖先写丢更新；工具与 GUI 桥并发写时真实发生。
    async add(market, instrument) {
      return enqueue(async () => {
        const map = await load()
        const rows = map[market] ?? []
        if (rows.some(row => row.symbol === instrument.symbol)) return false
        const next = { ...map, [market]: [...rows, { ...instrument }] }
        cache = next
        await writeNow(next)
        return true
      })
    },
    async remove(market, symbol) {
      return enqueue(async () => {
        const map = await load()
        const existing = map[market]
        const rows = Array.isArray(existing) ? existing : (WATCHLIST_SEEDS[market] ?? [])
        const nextRows = rows.filter(row => row.symbol !== symbol)
        if (nextRows.length === rows.length) return false
        const next = { ...map, [market]: nextRows }
        cache = next
        await writeNow(next)
        return true
      })
    },
    // 分组成员关系读改写与 add/remove 同队列串行化（issue #58 同款防丢更新）。
    async assignGroup(market, symbol, groupId, member) {
      return enqueue(async () => {
        const map = await load()
        const rows = map[market]
        if (!Array.isArray(rows)) return false
        const index = rows.findIndex(row => row.symbol === symbol)
        if (index < 0) return false
        const base = rows[index]
        const current = Array.isArray(base.groups) ? base.groups : []
        if (member === current.includes(groupId)) return false
        const nextGroups = member ? [...current, groupId] : current.filter(id => id !== groupId)
        // 显式重建行（不能 { ...base } 展开——移出后 groups 键会被原行带回）。
        const nextRows = [...rows]
        nextRows[index] = normalizeWatchlistRow({
          market: base.market,
          symbol: base.symbol,
          ...(base.name !== undefined ? { name: base.name } : {}),
          ...(nextGroups.length > 0 ? { groups: nextGroups } : {}),
        })
        const next = { ...map, [market]: nextRows }
        cache = next
        await writeNow(next)
        return true
      })
    },
    async stripGroup(groupId) {
      return enqueue(async () => {
        const map = await load()
        let cleaned = 0
        const next: WatchlistsMap = {}
        for (const [market, rows] of Object.entries(map)) {
          if (!Array.isArray(rows)) continue
          let changed = false
          const nextRows = rows.map((row) => {
            const groups = Array.isArray(row.groups) ? row.groups : []
            if (!groups.includes(groupId)) return row
            changed = true
            cleaned++
            const rest = groups.filter(id => id !== groupId)
            return normalizeWatchlistRow({
              market: row.market,
              symbol: row.symbol,
              ...(row.name !== undefined ? { name: row.name } : {}),
              ...(rest.length > 0 ? { groups: rest } : {}),
            })
          })
          next[market] = changed ? nextRows : rows
        }
        if (cleaned > 0) {
          cache = next
          await writeNow(next)
        }
        return cleaned
      })
    },
  }
}

/** 分组注册表落盘形状（容器包裹，后续加排序/置顶字段不动成员关系文件）。 */
interface WatchlistGroupsFile {
  groups: WatchlistGroup[]
}

export function createFileWatchlistGroupsStore(filePath: string): WatchlistGroupsStore {
  let cache: WatchlistGroup[] | null = null
  let pendingWrite = Promise.resolve()

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pendingWrite.then(fn, fn)
    pendingWrite = next.then(() => {}, () => {})
    return next
  }

  async function load(): Promise<WatchlistGroup[]> {
    if (cache !== null) return cache
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content) as Partial<WatchlistGroupsFile>
      cache = Array.isArray(parsed.groups)
        ? parsed.groups.filter(group =>
            typeof group === 'object' && group !== null
            && typeof (group as WatchlistGroup).id === 'string' && (group as WatchlistGroup).id !== ''
            && typeof (group as WatchlistGroup).name === 'string')
        : []
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/watchlist] failed to read watchlist groups from ${filePath}:`, err)
      }
      cache = []
    }
    return cache
  }

  function writeNow(groups: WatchlistGroup[]): Promise<void> {
    const file: WatchlistGroupsFile = { groups }
    return safeAtomicWrite(filePath, JSON.stringify(file, null, 2))
  }

  return {
    async list() {
      return [...(await load())]
    },
    async create(name) {
      return enqueue(async () => {
        const groups = await load()
        if (groups.some(group => group.name === name)) return { error: 'duplicate' } satisfies WatchlistGroupWriteResult
        const group: WatchlistGroup = { id: newWatchlistGroupId(), name, createdAt: Date.now() }
        cache = [...groups, group]
        await writeNow(cache)
        return { group } satisfies WatchlistGroupWriteResult
      })
    },
    async rename(id, name) {
      return enqueue(async () => {
        const groups = await load()
        const existing = groups.find(group => group.id === id)
        if (existing === undefined) return { error: 'not-found' } satisfies WatchlistGroupWriteResult
        if (groups.some(group => group.id !== id && group.name === name)) return { error: 'duplicate' } satisfies WatchlistGroupWriteResult
        cache = groups.map(group => (group.id === id ? { ...group, name } : group))
        await writeNow(cache)
        return { group: { ...existing, name } } satisfies WatchlistGroupWriteResult
      })
    },
    async remove(id) {
      return enqueue(async () => {
        const groups = await load()
        const next = groups.filter(group => group.id !== id)
        if (next.length === groups.length) return false
        cache = next
        await writeNow(next)
        return true
      })
    },
  }
}

export function createFileSelectionStore(filePath: string): SelectionStore {
  let cache: SelectionRecord | null = null
  let pendingWrite = Promise.resolve()

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pendingWrite.then(fn, fn)
    pendingWrite = next.then(() => {}, () => {})
    return next
  }

  async function load(): Promise<SelectionRecord> {
    if (cache !== null) return cache
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content) as SelectionRecord
      cache = parsed !== null && typeof parsed === 'object'
        ? { instrument: (parsed.instrument ?? null) as SelectionRecord['instrument'] }
        : { instrument: null }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/watchlist] failed to read selection from ${filePath}:`, err)
      }
      cache = { instrument: null }
    }
    return cache
  }

  async function flush(record: SelectionRecord): Promise<void> {
    return enqueue(async () => {
      await safeAtomicWrite(filePath, JSON.stringify(record, null, 2))
    })
  }

  return {
    async get() {
      const record = await load()
      return { instrument: record.instrument === null ? null : { ...record.instrument } }
    },
    async set(record) {
      cache = { instrument: record.instrument === null ? null : { ...record.instrument } }
      await flush(cache)
    },
  }
}
