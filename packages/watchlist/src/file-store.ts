/**
 * 文件持久化版自选/选中 store（Node.js 宿主侧使用，tmp+rename 原子写，
 * indicators/custom-fs 同款模式——issue #32 规格）。
 */
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SelectionRecord, SelectionStore, WatchlistStore, WatchlistsMap } from './index.ts'

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

  async function flush(map: WatchlistsMap): Promise<void> {
    return enqueue(async () => {
      await safeAtomicWrite(filePath, JSON.stringify(map, null, 2))
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
    async add(market, instrument) {
      const map = await load()
      const rows = map[market] ?? []
      if (rows.some(row => row.symbol === instrument.symbol)) return false
      const next = { ...map, [market]: [...rows, { ...instrument }] }
      cache = next
      await flush(next)
      return true
    },
    async remove(market, symbol) {
      const map = await load()
      const rows = map[market] ?? []
      const nextRows = rows.filter(row => row.symbol !== symbol)
      if (nextRows.length === rows.length) return false
      const next = { ...map, [market]: nextRows }
      cache = next
      await flush(next)
      return true
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
