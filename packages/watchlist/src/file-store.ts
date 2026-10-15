/**
 * 文件持久化版自选/选中 store（Node.js 宿主侧使用，issue #32 规格）。
 *
 * 读写骨架经 `@dshtrading/dsh-home` 的 {@link createRecordStoreAdapter}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写 + 落盘成功后才发布缓存（2026-10-09 多进程互相覆盖事故修复）：
 * 桌面端与 CLI 各写一行时双方都留在盘上，不再互相抹掉（此前是内存缓存 + 整表回写）。
 * 进程内的 enqueue 串行化保留（它保证同一进程内的读改写顺序），跨进程部分由锁承担。
 *
 * 本文件是「多文件形态」的自选域：成员关系（本文件）、分组注册表（容器包裹）与选中
 * 记录（非整表对象）各建一个适配器，读写形态互不共享。
 */
import { createRecordStoreAdapter, readStoreText } from '@dshtrading/dsh-home'
import type { SelectionRecord, SelectionStore, WatchlistGroup, WatchlistGroupsStore, WatchlistGroupWriteResult, WatchlistStore, WatchlistsMap } from './index.ts'
import { newWatchlistGroupId, normalizeWatchlistRow } from './index.ts'
import { WATCHLIST_SEEDS } from './seeds.ts'

const LOG_PREFIX = '[dsh-trading/watchlist] failed to atomic flush watchlists to'

export function createFileWatchlistStore(filePath: string): WatchlistStore {
  let pendingWrite = Promise.resolve()

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pendingWrite.then(fn, fn)
    pendingWrite = next.then(() => {}, () => {})
    return next
  }

  /** 读盘/解析失败的日志前缀（坏 JSON 与非 ENOENT 读失败同一条，与既有 load 口径逐字一致）。 */
  const READ_FAILED = `[dsh-trading/watchlist] failed to read watchlists from ${filePath}:`

  /** 文本 → 市场表：坏 JSON / 非对象降级空表，其余（含数组）静默丢弃（不外包）。 */
  function decode(text: string | undefined): WatchlistsMap {
    if (text === undefined) return {}
    try {
      const parsed = JSON.parse(text) as WatchlistsMap
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (err) {
      console.error(READ_FAILED, err)
      return {}
    }
  }

  const store = createRecordStoreAdapter<WatchlistsMap>({
    filePath,
    logPrefix: LOG_PREFIX,
    // 新鲜读盘（坏 JSON/非对象按空表）；供 load 与锁内重读共用。
    readFromDisk: () => readStoreText(filePath, READ_FAILED),
    decode,
    encode: map => map,
  })

  return {
    async list() {
      return { ...(await store.load()) }
    },
    async save(next) {
      await enqueue(async () => {
        await store.commit(() => ({ ...next }))
      })
    },
    // 读改写全程入队串行化（issue #58）并落在跨进程锁内：此前只有写盘排队，两个并发
    // add 都从同一旧态计算 next、后写覆盖先写丢更新；跨进程则由锁消除陈旧快照覆盖。
    async add(market, instrument) {
      let added = false
      await enqueue(async () => {
        await store.commit((onDisk) => {
          const rows = onDisk[market] ?? []
          if (rows.some(row => row.symbol === instrument.symbol)) return onDisk
          // 与内存版同款归一（审查 L6）：groups 空数组不落键、去重，落盘形状一致。
          added = true
          return { ...onDisk, [market]: [...rows, normalizeWatchlistRow(instrument)] }
        })
      })
      return added
    },
    async remove(market, symbol) {
      let removed = false
      await enqueue(async () => {
        await store.commit((onDisk) => {
          const existing = onDisk[market]
          const rows = Array.isArray(existing) ? existing : (WATCHLIST_SEEDS[market] ?? [])
          const nextRows = rows.filter(row => row.symbol !== symbol)
          if (nextRows.length === rows.length) return onDisk
          removed = true
          return { ...onDisk, [market]: nextRows }
        })
      })
      return removed
    },
    // 分组成员关系读改写与 add/remove 同队列串行化（issue #58 同款防丢更新），并落在锁内。
    async assignGroup(market, symbol, groupId, member) {
      let assigned = false
      await enqueue(async () => {
        await store.commit((onDisk) => {
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
        })
      })
      return assigned
    },
    async stripGroup(groupId) {
      let cleaned = 0
      await enqueue(async () => {
        await store.commit((onDisk) => {
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
        })
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
  let pendingWrite = Promise.resolve()

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pendingWrite.then(fn, fn)
    pendingWrite = next.then(() => {}, () => {})
    return next
  }

  /** 读盘/解析失败的日志前缀（坏 JSON 与非 ENOENT 读失败同一条，与既有 load 口径逐字一致）。 */
  const READ_FAILED = `[dsh-trading/watchlist] failed to read watchlist groups from ${filePath}:`

  /** 文本 → 分组表：容器包裹（`{ groups: [] }`）逐条过滤形状；坏 JSON 降级空表并打日志。 */
  function decode(text: string | undefined): WatchlistGroup[] {
    if (text === undefined) return []
    try {
      const parsed = JSON.parse(text) as Partial<WatchlistGroupsFile>
      return Array.isArray(parsed.groups)
        ? parsed.groups.filter(group =>
            typeof group === 'object' && group !== null
            && typeof (group as WatchlistGroup).id === 'string' && (group as WatchlistGroup).id !== ''
            && typeof (group as WatchlistGroup).name === 'string')
        : []
    } catch (err) {
      console.error(READ_FAILED, err)
      return []
    }
  }

  const store = createRecordStoreAdapter<WatchlistGroup[]>({
    filePath,
    logPrefix: LOG_PREFIX,
    // 新鲜读盘（容器包裹；坏形过滤）；供 load 与锁内重读共用。
    readFromDisk: () => readStoreText(filePath, READ_FAILED),
    decode,
    encode: groups => ({ groups }),
  })

  /**
   * 跨进程读改写；mutate 返回 null 表示无变化（不落盘），缓存仍取锁内新鲜值。
   * 返回 null 是分组工具的既有写法，逐字保留。
   */
  async function commit(
    mutate: (onDisk: WatchlistGroup[]) => WatchlistGroup[] | null,
  ): Promise<WatchlistGroup[]> {
    return store.commit((onDisk) => mutate(onDisk) ?? onDisk)
  }

  return {
    async list() {
      return [...(await store.load())]
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
  let pendingWrite = Promise.resolve()

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pendingWrite.then(fn, fn)
    pendingWrite = next.then(() => {}, () => {})
    return next
  }

  /** 读盘/解析失败的日志前缀（坏 JSON 与非 ENOENT 读失败同一条，与既有 load 口径逐字一致）。 */
  const READ_FAILED = `[dsh-trading/watchlist] failed to read selection from ${filePath}:`

  /** 文本 → 选中记录：坏形按空选中；只取 instrument 一个键（其它键不落回）。 */
  function decode(text: string | undefined): SelectionRecord {
    if (text === undefined) return { instrument: null }
    try {
      const parsed = JSON.parse(text) as SelectionRecord
      return parsed !== null && typeof parsed === 'object'
        ? { instrument: (parsed.instrument ?? null) as SelectionRecord['instrument'] }
        : { instrument: null }
    } catch (err) {
      console.error(READ_FAILED, err)
      return { instrument: null }
    }
  }

  const store = createRecordStoreAdapter<SelectionRecord>({
    filePath,
    logPrefix: LOG_PREFIX,
    // 新鲜读盘（坏形按空选中）；供 load 与锁内重读共用。
    readFromDisk: () => readStoreText(filePath, READ_FAILED),
    decode,
    encode: value => value,
  })

  return {
    async get() {
      const record = await store.load()
      return { instrument: record.instrument === null ? null : { ...record.instrument } }
    },
    async set(record) {
      await enqueue(async () => {
        await store.commit(() => ({ instrument: record.instrument === null ? null : { ...record.instrument } }))
      })
    },
  }
}
