/**
 * 文件持久化版自定义指标存储（Node.js 宿主侧使用）。
 *
 * 读写骨架经 `@dshtrading/dsh-home` 的 {@link createRecordStoreAdapter}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写 + 落盘成功后才发布缓存（2026-10-09 多进程互相覆盖事故修复）；
 * 错误日志与异常处理纪律不变。
 */
import { createRecordStoreAdapter, readStoreText, SKIP_WRITE } from '@dshtrading/dsh-home'
import type { CustomIndicatorRecord, CustomIndicatorStore } from './custom.ts'

const LOG_PREFIX = '[dsh-trading/indicators] failed to atomic flush custom indicators to'

export function createFileCustomIndicatorStore(filePath: string): CustomIndicatorStore {
  /** 读盘/解析失败的日志前缀（坏 JSON 与非 ENOENT 读失败同一条，与既有 load 口径逐字一致）。 */
  const READ_FAILED = `[dsh-trading/indicators] failed to read custom indicators from ${filePath}:`

  /** 文本 → 表：坏 JSON 降级空表并打日志，坏形状（非数组 / 缺 id）静默丢弃（不外包）。 */
  function decode(text: string | undefined): Map<string, CustomIndicatorRecord> {
    if (text === undefined) return new Map<string, CustomIndicatorRecord>()
    try {
      const parsed: unknown = JSON.parse(text)
      const map = new Map<string, CustomIndicatorRecord>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string') map.set(item.id, item)
        }
      }
      return map
    } catch (err) {
      console.error(READ_FAILED, err)
      return new Map<string, CustomIndicatorRecord>()
    }
  }

  const store = createRecordStoreAdapter<Map<string, CustomIndicatorRecord>>({
    filePath,
    logPrefix: LOG_PREFIX,
    // 新鲜读盘（坏 JSON/坏形同既有 load 口径降级空表）；供缓存与锁内重读共用。
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
    async remove(id) {
      let existed = false
      await store.commit((onDisk) => {
        existed = onDisk.delete(id)
        return existed ? onDisk : SKIP_WRITE
      })
      return existed
    },
  }
}
