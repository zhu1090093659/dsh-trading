/**
 * 文件持久化版知识卡片存储（Node.js 宿主端专用）。
 *
 * 采用 tmp + rename 原子写入模式，并包含明确的错误日志与异常处理（逐行对齐 custom-fs.ts 先例）。
 */
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { KnowledgeCard, KnowledgeCardStore } from './types.ts'

export function createFileKnowledgeCardStore(filePath: string): KnowledgeCardStore {
  let cache: Map<string, KnowledgeCard> | null = null

  async function load(): Promise<Map<string, KnowledgeCard>> {
    if (cache !== null) return cache
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)
      const map = new Map<string, KnowledgeCard>()
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string') map.set(item.id, item)
        }
      }
      cache = map
      return map
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/knowledge] failed to read knowledge cards from ${filePath}:`, err)
      }
      cache = new Map<string, KnowledgeCard>()
      return cache
    }
  }

  async function flush(map: Map<string, KnowledgeCard>): Promise<void> {
    const dir = dirname(filePath)
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    try {
      await mkdir(dir, { recursive: true })
      const data = JSON.stringify([...map.values()], null, 2)
      await writeFile(tmpPath, data, 'utf8')
      await rename(tmpPath, filePath)
    } catch (error) {
      console.error(`[dsh-trading/knowledge] failed to atomic flush knowledge cards to ${filePath}:`, error)
      try {
        await unlink(tmpPath).catch(() => {})
      } catch {}
      throw error
    }
  }

  return {
    async list(): Promise<readonly KnowledgeCard[]> {
      const map = await load()
      return [...map.values()]
    },
    async get(id: string): Promise<KnowledgeCard | undefined> {
      const map = await load()
      return map.get(id)
    },
    async getByUrl(url: string): Promise<KnowledgeCard | undefined> {
      const map = await load()
      const trimmed = url.trim()
      for (const card of map.values()) {
        if (card.source.url.trim() === trimmed) {
          return card
        }
      }
      return undefined
    },
    async save(card: KnowledgeCard): Promise<void> {
      const map = await load()
      map.set(card.id, { ...card })
      await flush(map)
    },
    async delete(id: string): Promise<boolean> {
      const map = await load()
      const existed = map.delete(id)
      if (existed) await flush(map)
      return existed
    },
  }
}
