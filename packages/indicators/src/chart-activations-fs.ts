/**
 * 文件持久化版图表激活名册存储（Node.js 宿主侧使用，issue #63）。
 *
 * 整表持久化经 `@dshtrading/dsh-home` 的 {@link transactStore}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写（2026-10-09 多进程互相覆盖事故修复）。此前是「内存缓存 +
 * 整表回写」，两个共用同一 DSH_HOME 的宿主进程会互相覆盖（实测抹掉 active_buy_real
 * 的 symbolParams / hiddenScopes）。
 */
import { readFile } from 'node:fs/promises'
import { SKIP_WRITE, transactStore, type SkipWrite } from '@dshtrading/dsh-home'
import type { IndicatorInstance } from './types.ts'
import type { ChartActivationStore } from './chart-activations.ts'
import { sanitizeInstance } from './chart-activations.ts'

const LOG_PREFIX = '[dsh-trading/indicators] failed to atomic flush chart activations to'

export function createFileChartActivationStore(filePath: string): ChartActivationStore {
  let cache: Map<string, IndicatorInstance> | null = null

  /** 新鲜读盘（坏 JSON/坏形同既有 load 口径降级空表）；供 load 与锁内重读共用。 */
  async function readFromDisk(): Promise<Map<string, IndicatorInstance>> {
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed: unknown = JSON.parse(content)
      const map = new Map<string, IndicatorInstance>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const clean = sanitizeInstance(item)
          if (clean !== undefined) map.set(clean.id, clean)
        }
      }
      return map
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        console.error(`[dsh-trading/indicators] failed to read chart activations from ${filePath}:`, err)
      }
      return new Map<string, IndicatorInstance>()
    }
  }

  async function load(): Promise<Map<string, IndicatorInstance>> {
    if (cache !== null) return cache
    cache = await readFromDisk()
    return cache
  }

  /** 锁内读改写：mutate 拿到磁盘新鲜表，返回的即本次要缓存并落盘的表。 */
  async function commit(
    mutate: (onDisk: Map<string, IndicatorInstance>) => Map<string, IndicatorInstance> | SkipWrite,
  ): Promise<Map<string, IndicatorInstance>> {
    cache = await transactStore(filePath, readFromDisk, mutate, table => [...table.values()], LOG_PREFIX)
    return cache
  }

  return {
    async list() {
      const map = await load()
      return [...map.values()].map(instance => sanitizeInstance(instance) as IndicatorInstance)
    },
    async activate(instance) {
      const clean = sanitizeInstance(instance)
      if (clean === undefined) {
        throw new Error('chart activation: invalid instance shape for id ' + JSON.stringify((instance as { id?: unknown } | null | undefined)?.id))
      }
      await commit((onDisk) => {
        onDisk.set(clean.id, clean)
        return onDisk
      })
    },
    async deactivate(id) {
      // 先取锁内新鲜表判断存在性，再在同一临界区删除——丢更新与「删了对方刚写的行」都不发生。
      let existed = false
      await commit((onDisk) => {
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
      cache = await transactStore(filePath, readFromDisk, () => next, table => [...table.values()], LOG_PREFIX)
    },
  }
}
