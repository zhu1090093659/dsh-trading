/**
 * 文件持久化版内置策略/选股器墓碑存储（Node.js 宿主侧使用，
 * 落 ~/.dsh/strategies/builtin-tombstones.json，形状 { deleted: string[] }）。
 *
 * 与 custom-fs.ts 同款 tmp + rename 原子写入模式；旧宿主从未写过该文件，
 * 无迁移问题（ENOENT 视为空表）。
 */
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BuiltinTombstonesStore } from './builtin-tombstones.ts'

export function createFileBuiltinTombstonesStore(filePath: string): BuiltinTombstonesStore {
  let cache: Set<string> | null = null

  async function load(): Promise<Set<string>> {
    if (cache !== null) return cache
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content) as { deleted?: unknown }
      const set = new Set<string>()
      if (Array.isArray(parsed?.deleted)) {
        for (const id of parsed.deleted) {
          if (typeof id === 'string' && id) set.add(id)
        }
      }
      cache = set
      return set
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/strategies] failed to read builtin tombstones from ${filePath}:`, err)
      }
      cache = new Set<string>()
      return cache
    }
  }

  async function flush(set: Set<string>): Promise<void> {
    const dir = dirname(filePath)
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    const data = JSON.stringify({ deleted: [...set] }, null, 2)
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
      console.error(`[dsh-trading/strategies] failed to atomic flush builtin tombstones to ${filePath}:`, error)
      await unlink(tmpPath).catch(() => {})
      throw error
    }
  }

  return {
    async list() {
      const set = await load()
      return [...set]
    },
    async add(id) {
      const set = await load()
      const fresh = !set.has(id)
      if (fresh) {
        set.add(id)
        await flush(set)
      }
      return fresh
    },
    async remove(id) {
      const set = await load()
      const existed = set.delete(id)
      if (existed) await flush(set)
      return existed
    },
  }
}
