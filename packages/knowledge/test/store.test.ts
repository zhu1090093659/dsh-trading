import { describe, expect, it, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { createMemoryKnowledgeCardStore } from '../src/store-memory.ts'
import { createFileKnowledgeCardStore } from '../src/knowledge-fs.ts'
import type { KnowledgeCard } from '../src/types.ts'

function createSampleCard(id: string, url: string): KnowledgeCard {
  return {
    id,
    title: `Card ${id}`,
    summary: 'Summary text',
    source: {
      type: 'bilibili',
      url,
      author: 'UP',
    },
    credibility: 'high',
    coreClaims: ['Claim 1'],
    factCheck: { verified: ['V1'], discrepancies: [], unverifiable: [] },
    takeaways: ['T1'],
    boundaries: ['B1'],
    tags: ['Tag1'],
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  }
}

describe('Knowledge Card Store', () => {
  describe('Memory Store', () => {
    it('performs CRUD operations correctly', async () => {
      const store = createMemoryKnowledgeCardStore()
      const card = createSampleCard('kc_1', 'https://bilibili.com/video/BV123')

      await store.save(card)
      expect(await store.list()).toHaveLength(1)
      expect(await store.get('kc_1')).toEqual(card)
      expect(await store.getByUrl('https://bilibili.com/video/BV123')).toEqual(card)

      const deleted = await store.delete('kc_1')
      expect(deleted).toBe(true)
      expect(await store.list()).toHaveLength(0)
    })
  })

  describe('File Store (Atomic)', () => {
    const tmpFile = path.join(os.tmpdir(), `test_knowledge_cards_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`)

    afterEach(async () => {
      try {
        await unlink(tmpFile)
      } catch {}
    })

    it('persists cards atomically to disk', async () => {
      const store1 = createFileKnowledgeCardStore(tmpFile)
      const card = createSampleCard('kc_disk_1', 'https://bilibili.com/video/BVDisk1')

      await store1.save(card)
      expect(await store1.list()).toHaveLength(1)

      // 重新实例化读取同一文件
      const store2 = createFileKnowledgeCardStore(tmpFile)
      const loaded = await store2.get('kc_disk_1')
      expect(loaded).toBeDefined()
      expect(loaded?.title).toBe('Card kc_disk_1')
    })
  })
})
