/**
 * 文件持久化版自选/选中 store（Node.js 宿主侧使用，issue #32 规格）。
 *
 * 写路径经 `@dshtrading/dsh-home` 的 {@link transactStore}——跨进程排他锁 + 锁内
 * 新鲜读盘 + 原子写（2026-10-09 多进程互相覆盖事故修复）：桌面端与 CLI 各写一行时
 * 双方都留在盘上，不再互相抹掉（此前是内存缓存 + 整表回写）。进程内的 enqueue 串行化
 * 保留（它保证同一进程内的读改写顺序），跨进程部分由锁承担。
 */
import { readFile } from 'node:fs/promises'
import { transactStore } from '@dshtrading/dsh-home'
import type { SelectionRecord, SelectionStore, WatchlistGroup, WatchlistGroupsStore, WatchlistGroupWriteResult, WatchlistStore, WatchlistsMap } from './index.ts'
import { newWatchlistGroupId, normalizeWatchlistRow } from './index.ts'
import { WATCHLIST_SEEDS } from './seeds.ts'

const LOG_PREFIX = '[dsh-trading/watchlist] failed to atomic flush watchlists to'

export function createFileWatchlistStore(filePath: string): WatchlistStore {
  let cache: WatchlistsMap | null = null
  let pendingWrite = Promise.resolve()

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pendingWrite.then(fn, fn)
    pendingWrite = next.then(() => {}, () => {})
    return next
  }

  /** 新鲜读盘（坏 JSON/非对象按空表）；供 load 与锁内重读共用。 */
  async function readFromDisk(): Promise<WatchlistsMap> {
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content) as WatchlistsMap
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/watchlist] failed to read watchlists from ${filePath}:`, err)
      }
      return {}
    }
  }

  async function load(): Promise<WatchlistsMap> {
    if (cache !== null) return cache
    cache = await readFromDisk()
    return cache
  }

  return {
    async list() {
      return { ...(await load()) }
    },
    async save(next) {
      await enqueue(async () => {
        cache = await transactStore(filePath, readFromDisk, () => ({ ...next }), (map) => map, LOG_PREFIX)
      })
    },
    // 读改写全程入队串行化（issue #58）并落在跨进程锁内：此前只有写盘排队，两个并发
    // add 都从同一旧态计算 next、后写覆盖先写丢更新；跨进程则由锁消除陈旧快照覆盖。
    async add(market, instrument) {
      let added = false
      await enqueue(async () => {
        cache = await transactStore(filePath, readFromDisk, (onDisk) => {
          const rows = onDisk[market] ?? []
          if (rows.some(row => row.symbol === instrument.symbol)) return onDisk
          // 与内存版同款归一（审查 L6）：groups 空数组不落键、去重，落盘形状一致。
          added = true
          return { ...onDisk, [market]: [...rows, normalizeWatchlistRow(instrument)] }
        }, (map) => map, LOG_PREFIX)
      })
      return added
    },
    async remove(market, symbol) {
      let removed = false
      await enqueue(async () => {
        cache = await transactStore(filePath, readFromDisk, (onDisk) => {
          const existing = onDisk[market]
          const rows = Array.isArray(existing) ? existing : (WATCHLIST_SEEDS[market] ?? [])
          const nextRows = rows.filter(row => row.symbol !== symbol)
          if (nextRows.length === rows.length) return onDisk
          removed = true
          return { ...onDisk, [market]: nextRows }
        }, (map) => map, LOG_PREFIX)
      })
      return removed
    },
    // 分组成员关系读改写与 add/remove 同队列串行化（issue #58 同款防丢更新），并落在锁内。
    async assignGroup(market, symbol, groupId, member) {
      let assigned = false
      await enqueue(async () => {
        cache = await transactStore(filePath, readFromDisk, (onDisk) => {
          const rows = onDisk[market]
          if (!Array.isArray(rows)) return onDisk
          const index = rows.findIndex(row => row.symbol === symbol)
          if (index < 0) return onDisk
          const base = rows[index]
          if (base === undefined) return onDisk
          const current = Array.isArray(base.groups) ? base.groups : []
          if (member === current.includes(groupId)) return onDisk
          const nextGroups = member ? [...current, groupId] : current.filter(id => id !== groupId)
          // 显式重建行（不能 { ...base } 展开——移出后 groups 键会被原行带回）。
          const nextRows = [...rows]
          nextRows[index] = normalizeWatchlistRow({
            market: base.market,
            symbol: base.symbol,
            ...(base.name !== undefined ? { name: base.name } : {}),
            ...(base.form !== undefined ? { form: base.form } : {}),
            ...(base.assetClass !== undefined ? { assetClass: base.assetClass } : {}),
            ...(nextGroups.length > 0 ? { groups: nextGroups } : {}),
          })
          assigned = true
          return { ...onDisk, [market]: nextRows }
        }, (map) => map, LOG_PREFIX)
      })
      return assigned
    },
    async stripGroup(groupId) {
      let cleaned = 0
      await enqueue(async () => {
        cache = await transactStore(filePath, readFromDisk, (onDisk) => {
          const next: WatchlistsMap = {}
          for (const [market, rows] of Object.entries(onDisk)) {
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
                ...(row.form !== undefined ? { form: row.form } : {}),
                ...(row.assetClass !== undefined ? { assetClass: row.assetClass } : {}),
                ...(rest.length > 0 ? { groups: rest } : {}),
              })
            })
            next[market] = changed ? nextRows : rows
          }
          return cleaned > 0 ? next : onDisk
        }, (map) => map, LOG_PREFIX)
      })
      return cleaned
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

  /** 新鲜读盘（容器包裹；坏形过滤）；供 load 与锁内重读共用。 */
  async function readFromDisk(): Promise<WatchlistGroup[]> {
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content) as Partial<WatchlistGroupsFile>
      return Array.isArray(parsed.groups)
        ? parsed.groups.filter(group =>
            typeof group === 'object' && group !== null
            && typeof (group as WatchlistGroup).id === 'string' && (group as WatchlistGroup).id !== ''
            && typeof (group as WatchlistGroup).name === 'string')
        : []
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/watchlist] failed to read watchlist groups from ${filePath}:`, err)
      }
      return []
    }
  }

  async function load(): Promise<WatchlistGroup[]> {
    if (cache !== null) return cache
    cache = await readFromDisk()
    return cache
  }

  const serialize = (groups: WatchlistGroup[]): WatchlistGroupsFile => ({ groups })

  /** 跨进程读改写；返回 null 表示无变化（不落盘），缓存仍取锁内新鲜值。 */
  async function commit(
    mutate: (onDisk: WatchlistGroup[]) => WatchlistGroup[] | null,
  ): Promise<WatchlistGroup[]> {
    cache = await transactStore(filePath, readFromDisk, (onDisk) => mutate(onDisk) ?? onDisk, serialize, LOG_PREFIX)
    return cache
  }

  return {
    async list() {
      return [...(await load())]
    },
    async create(name) {
      let result: WatchlistGroupWriteResult | undefined
      await enqueue(async () => {
        await commit((onDisk) => {
          if (onDisk.some(group => group.name === name)) {
            result = { error: 'duplicate' } satisfies WatchlistGroupWriteResult
            return null
          }
          const group: WatchlistGroup = { id: newWatchlistGroupId(), name, createdAt: Date.now() }
          result = { group } satisfies WatchlistGroupWriteResult
          return [...onDisk, group]
        })
      })
      return result ?? { error: 'duplicate' }
    },
    async rename(id, name) {
      let result: WatchlistGroupWriteResult | undefined
      await enqueue(async () => {
        await commit((onDisk) => {
          const existing = onDisk.find(group => group.id === id)
          if (existing === undefined) {
            result = { error: 'not-found' } satisfies WatchlistGroupWriteResult
            return null
          }
          if (onDisk.some(group => group.id !== id && group.name === name)) {
            result = { error: 'duplicate' } satisfies WatchlistGroupWriteResult
            return null
          }
          result = { group: { ...existing, name } } satisfies WatchlistGroupWriteResult
          return onDisk.map(group => (group.id === id ? { ...group, name } : group))
        })
      })
      return result ?? { error: 'not-found' }
    },
    async remove(id) {
      let removed = false
      await enqueue(async () => {
        await commit((onDisk) => {
          const next = onDisk.filter(group => group.id !== id)
          if (next.length === onDisk.length) return null
          removed = true
          return next
        })
      })
      return removed
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

  /** 新鲜读盘（坏形按空选中）；供 load 与锁内重读共用。 */
  async function readFromDisk(): Promise<SelectionRecord> {
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content) as SelectionRecord
      return parsed !== null && typeof parsed === 'object'
        ? { instrument: (parsed.instrument ?? null) as SelectionRecord['instrument'] }
        : { instrument: null }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/watchlist] failed to read selection from ${filePath}:`, err)
      }
      return { instrument: null }
    }
  }

  async function load(): Promise<SelectionRecord> {
    if (cache !== null) return cache
    cache = await readFromDisk()
    return cache
  }

  return {
    async get() {
      const record = await load()
      return { instrument: record.instrument === null ? null : { ...record.instrument } }
    },
    async set(record) {
      await enqueue(async () => {
        cache = await transactStore(
          filePath,
          readFromDisk,
          () => ({ instrument: record.instrument === null ? null : { ...record.instrument } }),
          (value) => value,
          LOG_PREFIX,
        )
      })
    },
  }
}
