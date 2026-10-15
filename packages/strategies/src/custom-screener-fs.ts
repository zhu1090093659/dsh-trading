/**
 * 文件持久化版自定义选股器存储（Node.js 宿主侧使用，
 * 落 ~/.dsh/strategies/custom-screeners.json）。
 *
 * 读写骨架经 `@dshtrading/dsh-home` 的 {@link createRecordStoreAdapter}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写 + 落盘成功后才发布缓存（2026-10-09 多进程互相覆盖事故修复）。
 * remove(archive=true) 先把被删记录归档到 sidecar（<path>.archive.jsonl，JSONL
 * 追加）——选股器管理丢弃用户 override 时可找回（2026-09-07 审查补强）。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createRecordStoreAdapter, readStoreText, SKIP_WRITE } from '@dshtrading/dsh-home'
import type { CustomScreenerRecord, CustomScreenerStore } from './custom-screener.ts'

const LOG_PREFIX = '[dsh-trading/strategies] failed to atomic flush custom screeners to'

export function createFileCustomScreenerStore(filePath: string): CustomScreenerStore {
  /** 读盘/解析失败的日志前缀（坏 JSON 与非 ENOENT 读失败同一条，与既有 load 口径逐字一致）。 */
  const READ_FAILED = `[dsh-trading/strategies] failed to read custom screeners from ${filePath}:`

  /** 文本 → 表：坏 JSON 降级空表并打日志，坏形状（非数组 / 缺 id）静默丢弃（不外包）。 */
  function decode(text: string | undefined): Map<string, CustomScreenerRecord> {
    if (text === undefined) return new Map<string, CustomScreenerRecord>()
    try {
      const parsed: unknown = JSON.parse(text)
      const map = new Map<string, CustomScreenerRecord>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string') map.set(item.id, item)
        }
      }
      return map
    } catch (err) {
      console.error(READ_FAILED, err)
      return new Map<string, CustomScreenerRecord>()
    }
  }

  const store = createRecordStoreAdapter<Map<string, CustomScreenerRecord>>({
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
      let removedRecord: CustomScreenerRecord | undefined
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
          console.error('[dsh-trading/strategies] failed to archive removed screener record:', error)
        }
      }
      return existed
    },
  }
}
