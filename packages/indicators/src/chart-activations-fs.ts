/**
 * 文件持久化版图表激活名册存储（Node.js 宿主侧使用，issue #63）。
 * 与 custom-fs.ts 同款 tmp + rename 原子写入模式与错误日志纪律。
 */
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from '@dshtrading/dsh-home'
import type { IndicatorInstance } from './types.ts'
import type { ChartActivationStore } from './chart-activations.ts'
import { sanitizeInstance } from './chart-activations.ts'

export function createFileChartActivationStore(filePath: string): ChartActivationStore {
  let cache: Map<string, IndicatorInstance> | null = null

  async function load(): Promise<Map<string, IndicatorInstance>> {
    if (cache !== null) return cache
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
      cache = map
      return map
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        console.error(`[dsh-trading/indicators] failed to read chart activations from ${filePath}:`, err)
      }
      cache = new Map<string, IndicatorInstance>()
      return cache
    }
  }

  async function flush(map: Map<string, IndicatorInstance>): Promise<void> {
    await writeJsonAtomic(filePath, [...map.values()], '[dsh-trading/indicators] failed to atomic flush chart activations to')
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
      const map = await load()
      map.set(clean.id, clean)
      await flush(map)
    },
    async deactivate(id) {
      const map = await load()
      const existed = map.delete(id)
      if (existed) await flush(map)
      return existed
    },
    async replaceAll(instances) {
      const map = new Map<string, IndicatorInstance>()
      for (const item of instances) {
        const clean = sanitizeInstance(item)
        if (clean !== undefined) map.set(clean.id, clean)
      }
      cache = map
      await flush(map)
    },
  }
}
