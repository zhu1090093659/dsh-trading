/**
 * 文件持久化版自定义策略存储（Node.js 宿主侧使用，落 ~/.dsh/strategies/custom.json）。
 *
 * 与 indicators/src/custom-fs.ts 同款 tmp + rename 原子写入模式（issue #31 规格）。
 * remove(archive=true) 会先把被删记录归档到 sidecar 文件（<path>.archive.jsonl，
 * JSONL 追加）——策略管理（覆盖 + 墓碑）丢弃用户 override 时可找回（2026-09-07）。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeJsonAtomic } from '@dshtrading/dsh-home'
import type { CustomStrategyRecord, CustomStrategyStore } from './custom.ts'

export interface ArchiveCapableStore extends CustomStrategyStore {
  /** 删除前把记录追加归档（archive=false 保持旧行为，无归档）。 */
  remove(id: string, archive?: boolean): Promise<boolean>
}

/** 归档读取（策略管理测试用）：同路径 .archive.jsonl 的记录行。 */
export async function readArchivedStrategyRecords(archivePath: string): Promise<CustomStrategyRecord[]> {
  const out: CustomStrategyRecord[] = []
  try {
    const content = await readFile(archivePath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as CustomStrategyRecord)
      } catch {
        // 单行损坏不影响其余归档（JSONL 容错）。
      }
    }
  } catch {
    // 无归档文件 = 空归档。
  }
  return out
}

export function createFileCustomStrategyStore(filePath: string): CustomStrategyStore {
  let cache: Map<string, CustomStrategyRecord> | null = null

  async function load(): Promise<Map<string, CustomStrategyRecord>> {
    if (cache !== null) return cache
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)
      const map = new Map<string, CustomStrategyRecord>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string') map.set(item.id, item)
        }
      }
      cache = map
      return map
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/strategies] failed to read custom strategies from ${filePath}:`, err)
      }
      cache = new Map<string, CustomStrategyRecord>()
      return cache
    }
  }

  async function flush(map: Map<string, CustomStrategyRecord>): Promise<void> {
    await writeJsonAtomic(filePath, [...map.values()], '[dsh-trading/strategies] failed to atomic flush custom strategies to')
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
            console.error('[dsh-trading/strategies] failed to archive removed strategy record:', error)
          }
        }
        await flush(map)
      }
      return existed
    },
  }
}
