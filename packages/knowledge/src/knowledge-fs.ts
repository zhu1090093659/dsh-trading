/**
 * 文件持久化版知识卡片存储（Node.js 宿主端专用）。
 *
 * 采用 tmp + rename 原子写入模式，并包含明确的错误日志与异常处理（逐行对齐 custom-fs.ts 先例）。
 */
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from '@dshtrading/dsh-home'
import type { KnowledgeCard, KnowledgeCardStore } from './types.ts'
import { canonicalizeCardAuthor } from './authors.ts'

export function createFileKnowledgeCardStore(filePath: string): KnowledgeCardStore {
  let cache: Map<string, KnowledgeCard> | null = null

  async function load(): Promise<Map<string, KnowledgeCard>> {
    if (cache !== null) return cache
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)
      const map = new Map<string, KnowledgeCard>()
      if (Array.isArray(parsed)) {
        let healed = 0
        for (const item of parsed) {
          // 作者别名在读取时归一（authors.ts）：历史数据即刻在 GUI/检索层表现为规范名。
          // 读本身不写盘，但归一结果留在缓存里，会被下一次写操作的全表回写落盘——
          // 即一次静默迁移，故这里显式 log 一次，让「改别名表 = 改历史数据」可见。
          // 缺 source / 缺 id 的脏行原样保留（不丢数据）；结构性校验只在入库发生，
          // 但这类行仍会让 getByUrl/search/graph 的解引用抛错（既有边界，未在此收口）。
          if (item && typeof item.id === 'string') {
            const card = canonicalizeCardAuthor(item)
            if (card !== item) healed += 1
            map.set(item.id, card)
          }
        }
        if (healed > 0) {
          console.warn(`[dsh-trading/knowledge] 作者别名归一：读取时治愈 ${healed} 张历史卡片（${filePath}）；下一次写操作会把结果落盘`)
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
    await writeJsonAtomic(filePath, [...map.values()], '[dsh-trading/knowledge] failed to atomic flush knowledge cards to')
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
      // 写入边界也归一：任何调用方（工具、脚本、未来的 UI 写路径）塞进来的历史写法都
      // 不会落盘——load() 已把缓存治愈，加上这里，缓存里不会存在非规范作者，
      // 消除「写进去旧写法 / 读出来规范名」的双口径。
      map.set(card.id, canonicalizeCardAuthor({ ...card }))
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
