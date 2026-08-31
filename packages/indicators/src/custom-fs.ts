/**
 * 文件持久化版自定义指标存储（Node.js 宿主侧使用）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CustomIndicatorRecord, CustomIndicatorStore } from './custom.ts'

export function createFileCustomIndicatorStore(filePath: string): CustomIndicatorStore {
  let cache: Map<string, CustomIndicatorRecord> | null = null

  async function load(): Promise<Map<string, CustomIndicatorRecord>> {
    if (cache !== null) return cache
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)
      const map = new Map<string, CustomIndicatorRecord>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string') map.set(item.id, item)
        }
      }
      cache = map
      return map
    } catch {
      cache = new Map<string, CustomIndicatorRecord>()
      return cache
    }
  }

  async function flush(map: Map<string, CustomIndicatorRecord>): Promise<void> {
    try {
      await mkdir(dirname(filePath), { recursive: true })
      const data = JSON.stringify([...map.values()], null, 2)
      await writeFile(filePath, data, 'utf8')
    } catch {
      // 写入异常不崩进程
    }
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
    async remove(id) {
      const map = await load()
      const existed = map.delete(id)
      if (existed) await flush(map)
      return existed
    },
  }
}
