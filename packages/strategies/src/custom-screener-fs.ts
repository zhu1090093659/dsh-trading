/**
 * 文件持久化版自定义选股器存储（Node.js 宿主侧使用，
 * 落 ~/.dsh/strategies/custom-screeners.json）。
 *
 * 与 custom-fs.ts 同款 tmp + rename 原子写入模式。
 * remove(archive=true) 先把被删记录归档到 sidecar（<path>.archive.jsonl，JSONL
 * 追加）——选股器管理丢弃用户 override 时可找回（2026-09-07 审查补强）。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeJsonAtomic } from '@dshtrading/dsh-home'
import type { CustomScreenerRecord, CustomScreenerStore } from './custom-screener.ts'

export function createFileCustomScreenerStore(filePath: string): CustomScreenerStore {
  let cache: Map<string, CustomScreenerRecord> | null = null

  async function load(): Promise<Map<string, CustomScreenerRecord>> {
    if (cache !== null) return cache
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)
      const map = new Map<string, CustomScreenerRecord>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string') map.set(item.id, item)
        }
      }
      cache = map
      return map
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/strategies] failed to read custom screeners from ${filePath}:`, err)
      }
      cache = new Map<string, CustomScreenerRecord>()
      return cache
    }
  }

  async function flush(map: Map<string, CustomScreenerRecord>): Promise<void> {
    await writeJsonAtomic(filePath, [...map.values()], '[dsh-trading/strategies] failed to atomic flush custom screeners to')
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
      const map = await load()
      map.set(record.id, { ...record })
      await flush(map)
    },
    async remove(id, archive = false) {
      const map = await load()
      const removedRecord = map.get(id)
      const existed = map.delete(id)
      if (existed) {
        if (archive && removedRecord !== undefined) {
          // 归档先于主文件重写：归档失败仅告警，不阻断删除（墓碑语义已生效）。
          try {
            const archivePath = `${filePath}.archive.jsonl`
            await mkdir(dirname(filePath), { recursive: true })
            await appendFile(archivePath, `${JSON.stringify(removedRecord)}\n`)
          } catch (error) {
            console.error('[dsh-trading/strategies] failed to archive removed screener record:', error)
          }
        }
        await flush(map)
      }
      return existed
    },
  }
}
