/**
 * 文件持久化版自定义选股器存储（Node.js 宿主侧使用，
 * 落 ~/.dsh/strategies/custom-screeners.json）。
 *
 * 整表持久化经 `@dshtrading/dsh-home` 的 {@link transactStore}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写（2026-10-09 多进程互相覆盖事故修复）。
 * remove(archive=true) 先把被删记录归档到 sidecar（<path>.archive.jsonl，JSONL
 * 追加）——选股器管理丢弃用户 override 时可找回（2026-09-07 审查补强）。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SKIP_WRITE, transactStore } from '@dshtrading/dsh-home'
import type { CustomScreenerRecord, CustomScreenerStore } from './custom-screener.ts'

const LOG_PREFIX = '[dsh-trading/strategies] failed to atomic flush custom screeners to'

export function createFileCustomScreenerStore(filePath: string): CustomScreenerStore {
  let cache: Map<string, CustomScreenerRecord> | null = null

  /** 新鲜读盘（坏 JSON/坏形同既有 load 口径降级空表）；供 load 与锁内重读共用。 */
  async function readFromDisk(): Promise<Map<string, CustomScreenerRecord>> {
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)
      const map = new Map<string, CustomScreenerRecord>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string') map.set(item.id, item)
        }
      }
      return map
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/strategies] failed to read custom screeners from ${filePath}:`, err)
      }
      return new Map<string, CustomScreenerRecord>()
    }
  }

  async function load(): Promise<Map<string, CustomScreenerRecord>> {
    if (cache !== null) return cache
    cache = await readFromDisk()
    return cache
  }

  async function commit(
    mutate: (onDisk: Map<string, CustomScreenerRecord>) => Map<string, CustomScreenerRecord> | typeof SKIP_WRITE,
  ): Promise<Map<string, CustomScreenerRecord>> {
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
    async remove(id, archive = false) {
      let existed = false
      let removedRecord: CustomScreenerRecord | undefined
      await commit((onDisk) => {
        removedRecord = onDisk.get(id)
        existed = onDisk.delete(id)
        return existed ? onDisk : SKIP_WRITE
      })
      if (existed && archive && removedRecord !== undefined) {
        // 归档先于主文件重写：归档失败仅告警，不阻断删除（墓碑语义已生效）。
        try {
          const archivePath = `${filePath}.archive.jsonl`
          await mkdir(dirname(filePath), { recursive: true })
          await appendFile(archivePath, `${JSON.stringify(removedRecord)}\n`)
        } catch (error) {
          console.error('[dsh-trading/strategies] failed to archive removed screener record:', error)
        }
      }
      return existed
    },
  }
}
