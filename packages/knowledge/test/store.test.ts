import { describe, expect, it, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { readFile, unlink, writeFile } from 'node:fs/promises'
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

    it('用户读取历史 cards.json 时 list/get 返回归一的作者且不写盘', async () => {
      // Given: 一份含历史作者写法与一条畸形旧行（缺 source）的 cards.json
      const legacy = createSampleCard('kc_legacy_1', 'https://bilibili.com/video/BVLegacy1')
      const legacyRow = { ...legacy, source: { ...legacy.source, author: '鳄鱼派（公众号：像鳄鱼一样思考）' } }
      const malformedRow = { id: 'kc_malformed_1', title: '历史畸形行', tags: [] }
      await writeFile(tmpFile, JSON.stringify([legacyRow, malformedRow]), 'utf8')

      // When: 实例化文件 store 读取该文件
      const store = createFileKnowledgeCardStore(tmpFile)
      const loaded = await store.get('kc_legacy_1')
      const onDisk = JSON.parse(await readFile(tmpFile, 'utf8'))

      // Then: 读取面作者已归一；畸形旧行仍可读到（不丢数据）；读本身没有改写文件
      expect(loaded?.source.author).toBe('鳄鱼派（像鳄鱼一样思考）')
      expect(await store.list()).toHaveLength(2)
      expect(await store.get('kc_malformed_1')).toBeDefined()
      expect(onDisk[0].source.author).toBe('鳄鱼派（公众号：像鳄鱼一样思考）')
    })

    it('运营在下一次写盘时把历史作者的归一结果持久化到文件', async () => {
      // Given: 一份历史作者写法的 cards.json，已被读取（缓存内为规范名）
      const legacy = createSampleCard('kc_legacy_2', 'https://bilibili.com/video/BVLegacy2')
      const legacyRow = { ...legacy, source: { ...legacy.source, author: '像鳄鱼一样思考（鳄鱼派）' } }
      await writeFile(tmpFile, JSON.stringify([legacyRow]), 'utf8')
      const store = createFileKnowledgeCardStore(tmpFile)
      expect((await store.get('kc_legacy_2'))?.source.author).toBe('鳄鱼派（像鳄鱼一样思考）')

      // When: 发生一次无关写入（新增一张卡）
      await store.save(createSampleCard('kc_new_1', 'https://bilibili.com/video/BVNew1'))

      // Then: 文件里历史作者的写法也被改写为规范名（一次静默迁移）
      const onDisk = JSON.parse(await readFile(tmpFile, 'utf8'))
      const persisted = onDisk.find((c: { id: string }) => c.id === 'kc_legacy_2')
      expect(persisted.source.author).toBe('鳄鱼派（像鳄鱼一样思考）')
      expect(onDisk).toHaveLength(2)
    })

    it('用户直接 save 历史作者写法的卡片时落库即为规范名', async () => {
      // Given: 一个绕过 validate（直连 store）的写入方塞进历史写法
      const store = createFileKnowledgeCardStore(tmpFile)
      const legacy = createSampleCard('kc_direct_1', 'https://bilibili.com/video/BVDirect1')
      const legacyWriter = { ...legacy, source: { ...legacy.source, author: '中金点睛（刘刚、杨萱庭）' } }

      // When: 直接 save
      await store.save(legacyWriter)

      // Then: 内存与文件都是规范名（写读同口径）
      expect((await store.get('kc_direct_1'))?.source.author).toBe('中金点睛')
      const onDisk = JSON.parse(await readFile(tmpFile, 'utf8'))
      expect(onDisk[0].source.author).toBe('中金点睛')
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
