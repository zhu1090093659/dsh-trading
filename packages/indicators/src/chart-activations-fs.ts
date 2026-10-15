/**
 * 文件持久化版图表激活名册存储（Node.js 宿主侧使用，issue #63）。
 *
 * 读写骨架经 `@dshtrading/dsh-home` 的 {@link createRecordStoreAdapter}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写 + 落盘成功后才发布缓存（2026-10-09 多进程互相覆盖事故修复）。
 * 此前是「内存缓存 + 整表回写」，两个共用同一 DSH_HOME 的宿主进程会互相覆盖（实测抹掉
 * active_buy_real 的 symbolParams / hiddenScopes）。
 */
import { createRecordStoreAdapter, readStoreText, SKIP_WRITE } from '@dshtrading/dsh-home'
import type { IndicatorInstance } from './types.ts'
import type { ChartActivationStore } from './chart-activations.ts'
import { sanitizeInstance } from './chart-activations.ts'

const LOG_PREFIX = '[dsh-trading/indicators] failed to atomic flush chart activations to'

export function createFileChartActivationStore(filePath: string): ChartActivationStore {
  /** 读盘/解析失败的日志前缀（坏 JSON 与非 ENOENT 读失败同一条，与既有 load 口径逐字一致）。 */
  const READ_FAILED = `[dsh-trading/indicators] failed to read chart activations from ${filePath}:`

  /** 文本 → 名册：坏 JSON 降级空册并打日志；逐条过 sanitizeInstance（本 store 的差异）。 */
  function decode(text: string | undefined): Map<string, IndicatorInstance> {
    if (text === undefined) return new Map<string, IndicatorInstance>()
    try {
      const parsed: unknown = JSON.parse(text)
      const map = new Map<string, IndicatorInstance>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const clean = sanitizeInstance(item)
          if (clean !== undefined) map.set(clean.id, clean)
        }
      }
      return map
    } catch (err) {
      console.error(READ_FAILED, err)
      return new Map<string, IndicatorInstance>()
    }
  }

  const store = createRecordStoreAdapter<Map<string, IndicatorInstance>>({
    filePath,
    logPrefix: LOG_PREFIX,
    // 新鲜读盘（坏 JSON/坏形同既有 load 口径降级空册）；供 load 与锁内重读共用。
    readFromDisk: () => readStoreText(filePath, READ_FAILED),
    decode,
    encode: table => [...table.values()],
  })

  return {
    async list() {
      const map = await store.load()
      return [...map.values()].map(instance => sanitizeInstance(instance) as IndicatorInstance)
    },
    async activate(instance) {
      const clean = sanitizeInstance(instance)
      if (clean === undefined) {
        throw new Error('chart activation: invalid instance shape for id ' + JSON.stringify((instance as { id?: unknown } | null | undefined)?.id))
      }
      await store.commit((onDisk) => {
        onDisk.set(clean.id, clean)
        return onDisk
      })
    },
    async deactivate(id) {
      // 先取锁内新鲜表判断存在性，再在同一临界区删除——丢更新与「删了对方刚写的行」都不发生。
      let existed = false
      await store.commit((onDisk) => {
        existed = onDisk.delete(id)
        return existed ? onDisk : SKIP_WRITE
      })
      return existed
    },
    async replaceAll(instances) {
      const next = new Map<string, IndicatorInstance>()
      for (const item of instances) {
        const clean = sanitizeInstance(item)
        if (clean !== undefined) next.set(clean.id, clean)
      }
      // 全量替换是刻意的整表语义（一次性迁移导入，桥另有「非空拒绝」幂等闸门）：
      // 锁内直接覆盖，不并入磁盘既有内容。
      await store.commit(() => next)
    },
  }
}
