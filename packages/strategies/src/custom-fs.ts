/**
 * 文件持久化版自定义策略存储（Node.js 宿主侧使用，落 ~/.dsh/strategies/custom.json）。
 *
 * 与 indicators/src/custom-fs.ts 同款 tmp + rename 原子写入模式（issue #31 规格）。
 */
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CustomStrategyRecord, CustomStrategyStore } from './custom.ts'

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
        console.error(`[dsh-trading/strategies] failed to atomic flush custom strategies to ${filePath}:`, finalErr)
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
