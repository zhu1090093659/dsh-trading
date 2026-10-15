/**
 * 文件持久化版自定义策略存储（Node.js 宿主侧使用，落 ~/.dsh/strategies/custom.json）。
 *
 * 读写骨架经 `@dshtrading/dsh-home` 的 {@link createRecordStoreAdapter}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写 + 落盘成功后才发布缓存（2026-10-09 多进程互相覆盖事故修复；
 * issue #31 落盘形状不变）。
 * remove(archive=true) 会先把被删记录归档到 sidecar 文件（<path>.archive.jsonl，
 * JSONL 追加）——策略管理（覆盖 + 墓碑）丢弃用户 override 时可找回（2026-09-07）。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createRecordStoreAdapter, readStoreText, SKIP_WRITE } from '@dshtrading/dsh-home'
import type { CustomStrategyRecord, CustomStrategyStore } from './custom.ts'

const LOG_PREFIX = '[dsh-trading/strategies] failed to atomic flush custom strategies to'

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
  /** 读盘/解析失败的日志前缀（坏 JSON 与非 ENOENT 读失败同一条，与既有 load 口径逐字一致）。 */
  const READ_FAILED = `[dsh-trading/strategies] failed to read custom strategies from ${filePath}:`

  /** 文本 → 表：坏 JSON 降级空表并打日志，坏形状（非数组 / 缺 id）静默丢弃（不外包）。 */
  function decode(text: string | undefined): Map<string, CustomStrategyRecord> {
    if (text === undefined) return new Map<string, CustomStrategyRecord>()
    try {
      const parsed: unknown = JSON.parse(text)
      const map = new Map<string, CustomStrategyRecord>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string') map.set(item.id, item)
        }
      }
      return map
    } catch (err) {
      console.error(READ_FAILED, err)
      return new Map<string, CustomStrategyRecord>()
    }
  }

  const store = createRecordStoreAdapter<Map<string, CustomStrategyRecord>>({
    filePath,
    logPrefix: LOG_PREFIX,
    // 新鲜读盘（坏 JSON/坏形同既有 load 口径降级空表）；供 load 与锁内重读共用。
    readFromDisk: () => readStoreText(filePath, READ_FAILED),
    decode,
    encode: table => [...table.values()],
  })

  return {
    async list() {
      const map = await store.load()
      return [...map.values()]
    },
    async get(id) {
      const map = await store.load()
      return map.get(id)
    },
    async save(record) {
      await store.commit((onDisk) => {
        onDisk.set(record.id, { ...record })
        return onDisk
      })
    },
    async remove(id, archive = false) {
      let existed = false
      let removedRecord: CustomStrategyRecord | undefined
      await store.commit((onDisk) => {
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
          console.error('[dsh-trading/strategies] failed to archive removed strategy record:', error)
        }
      }
      return existed
    },
  }
}
