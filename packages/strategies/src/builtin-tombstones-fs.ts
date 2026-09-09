/**
 * 文件持久化版内置策略/选股器墓碑存储（Node.js 宿主侧使用，
 * 落 ~/.dsh/strategies/builtin-tombstones.json，形状 { deleted: string[] }）。
 *
 * 与 custom-fs.ts 同款 tmp + rename 原子写入模式；旧宿主从未写过该文件，
 * 无迁移问题（ENOENT 视为空表）。
 */
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from '@dshtrading/dsh-home'
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
    await writeJsonAtomic(filePath, { deleted: [...set] }, '[dsh-trading/strategies] failed to atomic flush builtin tombstones to')
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
