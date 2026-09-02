/**
 * 文件持久化版自定义指标存储（Node.js 宿主侧使用）。
 *
 * 采用 tmp + rename 原子写入模式，并包含明确的错误日志与异常处理。
 */
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
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
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/indicators] failed to read custom indicators from ${filePath}:`, err)
      }
      cache = new Map<string, CustomIndicatorRecord>()
      return cache
    }
  }

  async function flush(map: Map<string, CustomIndicatorRecord>): Promise<void> {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true })
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    const data = JSON.stringify([...map.values()], null, 2)
    try {
      await writeFile(tmpPath, data, 'utf8')
      let renamed = false
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await rename(tmpPath, filePath)
          renamed = true
          break
        } catch (err: any) {
          if (err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES') {
            await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
            continue
          }
          throw err
        }
      }
      if (!renamed) {
        await writeFile(filePath, data, 'utf8')
        await unlink(tmpPath).catch(() => {})
      }
    } catch (error) {
      try {
        await unlink(tmpPath).catch(() => {})
      } catch {}
      try {
        await writeFile(filePath, data, 'utf8')
      } catch (finalErr) {
        console.error(`[dsh-trading/indicators] failed to atomic flush custom indicators to ${filePath}:`, finalErr)
        throw finalErr
      }
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
