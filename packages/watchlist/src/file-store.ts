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
import { createRecordStoreAdapter, readStoreText, SKIP_WRITE } from '@dshtrading/dsh-home'
import type { SelectionRecord, SelectionStore, WatchlistGroup, WatchlistGroupsStore, WatchlistGroupWriteResult, WatchlistStore, WatchlistsMap } from './index.ts'
import { newWatchlistGroupId, normalizePinnedKey, normalizeWatchlistRow } from './index.ts'
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

/** 分组注册表 + 面板偏好的落盘形状（容器包裹：置顶键集与注册表同文件、同一实例）。 */
interface WatchlistGroupsFile {
  groups: WatchlistGroup[]
  /** 置顶键集（`market:symbol`）；缺省 = 无置顶，老文件零迁移。 */
  pinned?: string[]
}

/** 内存中的容器记录（pinned 恒为数组；落盘时空集不写键）。 */
interface WatchlistGroupsRecord {
  groups: WatchlistGroup[]
  pinned: string[]
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

  /** 文本 → 容器记录：`{ groups, pinned }` 逐条过滤形状；坏 JSON 降级空容器并打日志。 */
  function decode(text: string | undefined): WatchlistGroupsRecord {
    if (text === undefined) return { groups: [], pinned: [] }
    try {
      const parsed = JSON.parse(text) as Partial<WatchlistGroupsFile>
      const groups = Array.isArray(parsed.groups)
        ? parsed.groups.filter(group =>
            typeof group === 'object' && group !== null
            && typeof (group as WatchlistGroup).id === 'string' && (group as WatchlistGroup).id !== ''
            && typeof (group as WatchlistGroup).name === 'string')
        : []
      // 坏键剔除（无冒号/空段）并去重：盘上手改成垃圾也不会把置顶面板带崩。
      const pinned = Array.isArray(parsed.pinned)
        ? [...new Set(parsed.pinned.map(normalizePinnedKey).filter((key): key is string => key !== null))]
        : []
      return { groups, pinned }
    } catch (err) {
      console.error(READ_FAILED, err)
      return { groups: [], pinned: [] }
    }
  }

  const store = createRecordStoreAdapter<WatchlistGroupsRecord>({
    filePath,
    logPrefix: LOG_PREFIX,
    // 新鲜读盘（容器包裹；坏形过滤）；供 load 与锁内重读共用。
    readFromDisk: () => readStoreText(filePath, READ_FAILED),
    decode,
    encode: record => ({ groups: record.groups, ...(record.pinned.length > 0 ? { pinned: record.pinned } : {}) }),
  })

  /**
   * 跨进程读改写；mutate 返回 null 表示无变化（不落盘），缓存仍取锁内新鲜值。
   * 返回 null 是分组工具的既有写法，逐字保留。
   */
  async function commit(
    mutate: (onDisk: WatchlistGroupsRecord) => WatchlistGroupsRecord | null,
  ): Promise<WatchlistGroupsRecord> {
    // null = 无变化：必须换成 dsh-home 的 SKIP_WRITE 哨兵，否则「返回同一个值」
    // 仍会走整份原子重写（删一行自选就会重写分组文件；文件坏形被 decode 降级成
    // 空表时，这次重写等于把注册表抹掉）。
    return store.commit((onDisk) => mutate(onDisk) ?? SKIP_WRITE)
  }

  return {
    async list() {
      return [...(await store.load()).groups]
    },
    async create(name) {
      let result: WatchlistGroupWriteResult | undefined
      await enqueue(async () => {
        await commit((onDisk) => {
          if (onDisk.groups.some(group => group.name === name)) {
            result = { error: 'duplicate' } satisfies WatchlistGroupWriteResult
            return null
          }
          const group: WatchlistGroup = { id: newWatchlistGroupId(), name, createdAt: Date.now() }
          result = { group } satisfies WatchlistGroupWriteResult
          return { ...onDisk, groups: [...onDisk.groups, group] }
        })
      })
      return result ?? { error: 'duplicate' }
    },
    async rename(id, name) {
      let result: WatchlistGroupWriteResult | undefined
      await enqueue(async () => {
        await commit((onDisk) => {
          const existing = onDisk.groups.find(group => group.id === id)
          if (existing === undefined) {
            result = { error: 'not-found' } satisfies WatchlistGroupWriteResult
            return null
          }
          if (onDisk.groups.some(group => group.id !== id && group.name === name)) {
            result = { error: 'duplicate' } satisfies WatchlistGroupWriteResult
            return null
          }
          result = { group: { ...existing, name } } satisfies WatchlistGroupWriteResult
          return { ...onDisk, groups: onDisk.groups.map(group => (group.id === id ? { ...group, name } : group)) }
        })
      })
      return result ?? { error: 'not-found' }
    },
    async remove(id) {
      let removed = false
      await enqueue(async () => {
        await commit((onDisk) => {
          const next = onDisk.groups.filter(group => group.id !== id)
          if (next.length === onDisk.groups.length) return null
          removed = true
          return { ...onDisk, groups: next }
        })
      })
      return removed
    },
    async pinned() {
      return [...(await store.load()).pinned]
    },
    async setPinned(key, want) {
      const normalized = normalizePinnedKey(key)
      if (normalized === null) return false
      let changed = false
      await enqueue(async () => {
        await commit((onDisk) => {
          const has = onDisk.pinned.includes(normalized)
          if (has === want) return null
          changed = true
          return {
            ...onDisk,
            pinned: want ? [...onDisk.pinned, normalized] : onDisk.pinned.filter(entry => entry !== normalized),
          }
        })
      })
      return changed
    },
    async stripPinned(key) {
      const normalized = normalizePinnedKey(key)
      if (normalized === null) return false
      let changed = false
      await enqueue(async () => {
        await commit((onDisk) => {
          if (!onDisk.pinned.includes(normalized)) return null
          changed = true
          return { ...onDisk, pinned: onDisk.pinned.filter(entry => entry !== normalized) }
        })
      })
      return changed
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
