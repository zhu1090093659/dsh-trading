/**
 * 文件持久化版知识卡片存储（Node.js 宿主端专用）。
 *
 * 整表持久化经 `@dshtrading/dsh-home` 的 {@link transactStore}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写（2026-10-09 多进程互相覆盖事故修复）。读取面作者归一与坏
 * 文件降级纪律不变（逐行对齐 custom-fs.ts 先例）。
 */
import { readFile } from 'node:fs/promises'
import { SKIP_WRITE, transactStore } from '@dshtrading/dsh-home'
import type { KnowledgeCard, KnowledgeCardStore } from './types.ts'
import { canonicalizeCardAuthor } from './authors.ts'

const LOG_PREFIX = '[dsh-trading/knowledge] failed to atomic flush knowledge cards to'

export function createFileKnowledgeCardStore(filePath: string): KnowledgeCardStore {
  let cache: Map<string, KnowledgeCard> | null = null

  /**
   * 新鲜读盘（作者别名归一、坏 JSON 降级空表）；供 load 与锁内重读共用。
   *
   * 作者别名在读取时归一（authors.ts）：历史数据即刻在 GUI/检索层表现为规范名。
   * 读本身不写盘，但归一结果留在缓存里，会被下一次写操作的全表回写落盘——
   * 即一次静默迁移，故这里显式 log 一次，让「改别名表 = 改历史数据」可见。
   * 缺 source / 缺 id 的脏行原样保留（不丢数据）；结构性校验只在入库发生，
   * 但这类行仍会让 getByUrl/search/graph 的解引用抛错（既有边界，未在此收口）。
   */
  async function readFromDisk(): Promise<Map<string, KnowledgeCard>> {
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)
      const map = new Map<string, KnowledgeCard>()
      if (Array.isArray(parsed)) {
        let healed = 0
        for (const item of parsed) {
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
      return map
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-trading/knowledge] failed to read knowledge cards from ${filePath}:`, err)
      }
      return new Map<string, KnowledgeCard>()
    }
  }

  async function load(): Promise<Map<string, KnowledgeCard>> {
    if (cache !== null) return cache
    cache = await readFromDisk()
    return cache
  }

  async function commit(
    mutate: (onDisk: Map<string, KnowledgeCard>) => Map<string, KnowledgeCard> | typeof SKIP_WRITE,
  ): Promise<Map<string, KnowledgeCard>> {
    cache = await transactStore(filePath, readFromDisk, mutate, table => [...table.values()], LOG_PREFIX)
    return cache
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
      // 写入边界也归一：任何调用方（工具、脚本、未来的 UI 写路径）塞进来的历史写法都
      // 不会落盘——load() 已把缓存治愈，加上这里，缓存里不会存在非规范作者，
      // 消除「写进去旧写法 / 读出来规范名」的双口径。
      await commit((onDisk) => {
        onDisk.set(card.id, canonicalizeCardAuthor({ ...card }))
        return onDisk
      })
    },
    async delete(id: string): Promise<boolean> {
      let existed = false
      await commit((onDisk) => {
        existed = onDisk.delete(id)
        return existed ? onDisk : SKIP_WRITE
      })
      return existed
    },
  }
}
