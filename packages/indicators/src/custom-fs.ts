/**
 * 文件持久化版自定义指标存储（Node.js 宿主侧使用）。
 *
 * 整表持久化经 `@dshtrading/dsh-home` 的 {@link transactStore}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写（2026-10-09 多进程互相覆盖事故修复）；错误日志与异常处理
 * 纪律不变。
 */
import { readFile } from 'node:fs/promises'
import { SKIP_WRITE, transactStore } from '@dshtrading/dsh-home'
import type { CustomIndicatorRecord, CustomIndicatorStore } from './custom.ts'

const LOG_PREFIX = '[dsh-trading/indicators] failed to atomic flush custom indicators to'

export function createFileCustomIndicatorStore(filePath: string): CustomIndicatorStore {
  let cache: Map<string, CustomIndicatorRecord> | null = null

  /** 新鲜读盘（坏 JSON/坏形同既有 load 口径降级空表）；供 load 与锁内重读共用。 */
  async function readFromDisk(): Promise<Map<string, CustomIndicatorRecord>> {
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)
      const map = new Map<string, CustomIndicatorRecord>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string') map.set(item.id, item)
        }
      }
      return map
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/indicators] failed to read custom indicators from ${filePath}:`, err)
      }
      return new Map<string, CustomIndicatorRecord>()
    }
  }

  async function load(): Promise<Map<string, CustomIndicatorRecord>> {
    if (cache !== null) return cache
    cache = await readFromDisk()
    return cache
  }

  async function commit(
    mutate: (onDisk: Map<string, CustomIndicatorRecord>) => Map<string, CustomIndicatorRecord> | typeof SKIP_WRITE,
  ): Promise<Map<string, CustomIndicatorRecord>> {
    cache = await transactStore(filePath, readFromDisk, mutate, table => [...table.values()], LOG_PREFIX)
    return cache
  }

  return {
    async list() {
      const map = await load()
      return [...map.values()]
    },
    async get(id) {
      const map = await load()
      return map.get(id)
    },
    async save(record) {
      await commit((onDisk) => {
        onDisk.set(record.id, { ...record })
        return onDisk
      })
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
