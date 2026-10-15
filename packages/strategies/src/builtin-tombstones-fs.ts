/**
 * 文件持久化版内置策略/选股器墓碑存储（Node.js 宿主侧使用，
 * 落 ~/.dsh/strategies/builtin-tombstones.json，形状 { deleted: string[] }）。
 *
 * 读写骨架经 `@dshtrading/dsh-home` 的 {@link createRecordStoreAdapter}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写 + 落盘成功后才发布缓存（2026-10-09 多进程互相覆盖事故修复）：
 * 两进程各自删除的内置策略都留下来，后到者不会用陈旧墓碑集合覆盖。旧宿主从未写过该
 * 文件，无迁移问题（ENOENT 视为空表）。
 */
import { createRecordStoreAdapter, readStoreText, SKIP_WRITE } from '@dshtrading/dsh-home'
import type { BuiltinTombstonesStore } from './builtin-tombstones.ts'

const LOG_PREFIX = '[dsh-trading/strategies] failed to atomic flush builtin tombstones to'

export function createFileBuiltinTombstonesStore(filePath: string): BuiltinTombstonesStore {
  /** 读盘/解析失败的日志前缀（坏 JSON 与非 ENOENT 读失败同一条，与既有 load 口径逐字一致）。 */
  const READ_FAILED = `[dsh-trading/strategies] failed to read builtin tombstones from ${filePath}:`

  /**
   * 文本 → 墓碑集合：只收容器里的 `deleted` 字符串数组，去空串、去重；坏 JSON 降级空集
   * 并打日志，坏形（容器不是 `{ deleted: [] }`）静默降级空集。Set 形态是本 store 的差异。
   */
  function decode(text: string | undefined): Set<string> {
    if (text === undefined) return new Set<string>()
    try {
      const parsed = JSON.parse(text) as { deleted?: unknown }
      const set = new Set<string>()
      if (Array.isArray(parsed?.deleted)) {
        for (const id of parsed.deleted) {
          if (typeof id === 'string' && id) set.add(id)
        }
      }
      return set
    } catch (err) {
      console.error(READ_FAILED, err)
      return new Set<string>()
    }
  }

  const store = createRecordStoreAdapter<Set<string>>({
    filePath,
    logPrefix: LOG_PREFIX,
    // 新鲜读盘（坏 JSON 降级空集）；供 load 与锁内重读共用。
    readFromDisk: () => readStoreText(filePath, READ_FAILED),
    decode,
    encode: set => ({ deleted: [...set] }),
  })

  return {
    async list() {
      const set = await store.load()
      return [...set]
    },
    async add(id) {
      let fresh = false
      await store.commit((onDisk) => {
        fresh = !onDisk.has(id)
        if (fresh) onDisk.add(id)
        return fresh ? onDisk : SKIP_WRITE
      })
      return fresh
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
