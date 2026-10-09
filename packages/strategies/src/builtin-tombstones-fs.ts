/**
 * 文件持久化版内置策略/选股器墓碑存储（Node.js 宿主侧使用，
 * 落 ~/.dsh/strategies/builtin-tombstones.json，形状 { deleted: string[] }）。
 *
 * 整表持久化经 `@dshtrading/dsh-home` 的 {@link transactStore}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写（2026-10-09 多进程互相覆盖事故修复）：两进程各自删除的
 * 内置策略都留下来，后到者不会用陈旧墓碑集合覆盖。旧宿主从未写过该文件，
 * 无迁移问题（ENOENT 视为空表）。
 */
import { readFile } from 'node:fs/promises'
import { SKIP_WRITE, transactStore } from '@dshtrading/dsh-home'
import type { BuiltinTombstonesStore } from './builtin-tombstones.ts'

const LOG_PREFIX = '[dsh-trading/strategies] failed to atomic flush builtin tombstones to'

export function createFileBuiltinTombstonesStore(filePath: string): BuiltinTombstonesStore {
  let cache: Set<string> | null = null

  /** 新鲜读盘（坏 JSON 降级空表）；供 load 与锁内重读共用。 */
  async function readFromDisk(): Promise<Set<string>> {
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content) as { deleted?: unknown }
      const set = new Set<string>()
      if (Array.isArray(parsed?.deleted)) {
        for (const id of parsed.deleted) {
          if (typeof id === 'string' && id) set.add(id)
        }
      }
      return set
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/strategies] failed to read builtin tombstones from ${filePath}:`, err)
      }
      return new Set<string>()
    }
  }

  async function load(): Promise<Set<string>> {
    if (cache !== null) return cache
    cache = await readFromDisk()
    return cache
  }

  async function commit(
    mutate: (onDisk: Set<string>) => Set<string> | typeof SKIP_WRITE,
  ): Promise<Set<string>> {
    cache = await transactStore(filePath, readFromDisk, mutate, set => ({ deleted: [...set] }), LOG_PREFIX)
    return cache
  }

  return {
    async list() {
      const set = await load()
      return [...set]
    },
    async add(id) {
      let fresh = false
      await commit((onDisk) => {
        fresh = !onDisk.has(id)
        if (fresh) onDisk.add(id)
        return fresh ? onDisk : SKIP_WRITE
      })
      return fresh
    },
    async remove(id) {
      let existed = false
      await commit((onDisk) => {
        existed = onDisk.delete(id)
        return existed ? onDisk : SKIP_WRITE
      })
      return existed
    },
  }
}
