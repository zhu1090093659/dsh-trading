/**
 * 内存版知识卡片存储实现（用于浏览器端、单测或作为无文件系统环境下的兜底）。
 */
import type { KnowledgeCard, KnowledgeCardStore } from './types.ts'

export function createMemoryKnowledgeCardStore(initialCards: readonly KnowledgeCard[] = []): KnowledgeCardStore {
  const map = new Map<string, KnowledgeCard>()
  for (const c of initialCards) {
    map.set(c.id, { ...c })
  }

  return {
    async list(): Promise<readonly KnowledgeCard[]> {
      return Array.from(map.values())
    },
    async get(id: string): Promise<KnowledgeCard | undefined> {
      return map.get(id)
    },
    async getByUrl(url: string): Promise<KnowledgeCard | undefined> {
      const trimmed = url.trim()
      for (const card of map.values()) {
        if (card.source.url.trim() === trimmed) {
          return card
        }
      }
      return undefined
    },
    async save(card: KnowledgeCard): Promise<void> {
      map.set(card.id, { ...card })
    },
    async delete(id: string): Promise<boolean> {
      return map.delete(id)
    },
  }
}
