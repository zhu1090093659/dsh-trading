/**
 * knowledge_delete 引用清理的批量落盘（用户可见路径：证伪下架一张被大量引用的卡片）。
 *
 * 覆盖：
 *   - store 提供 saveMany 时，一次清理只落一次整表事务（原实现逐张 save = F+1 次）；
 *   - store 不提供 saveMany 时按逐张 save 降级，结果与批量通道逐值一致；
 *   - 两张通道下落盘内容等价（负对照：批量实现若漏写/写错会被等价断言当场捉住）。
 *
 * 无 mock/无 sleep：用真实文件 store（真事务）+ 契约化计数包装观察落盘次数。
 */
import { afterEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { createFileKnowledgeCardStore } from '../src/knowledge-fs.ts'
import { createKnowledgeDeleteTool } from '../src/tool.ts'
import type { KnowledgeCard, KnowledgeCardStore } from '../src/types.ts'

const roots: string[] = []

function tempFile(name: string): string {
  const root = path.join(os.tmpdir(), `kn_batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  roots.push(root)
  return path.join(root, name)
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

function card(id: string, opts: { related?: string[] } = {}): KnowledgeCard {
  return {
    id,
    title: `Card ${id}`,
    summary: 'Summary text',
    source: { type: 'bilibili', url: `https://bilibili.com/video/${id}`, author: 'UP', publishedAt: '2026-08-30' },
    credibility: 'high',
    coreClaims: ['Claim 1'],
    factCheck: { verified: [], discrepancies: [], unverifiable: [] },
    takeaways: [], boundaries: [], tags: ['Tag1'],
    ...(opts.related === undefined ? {} : { related: opts.related }),
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  }
}

/** 计数包装：saveMany 记 1 次落盘、save 记 1 次；可选剔除批量通道以测降级路径。 */
function countingStore(inner: KnowledgeCardStore, opts: { exposeBatch: boolean }) {
  const counters = { writes: 0 }
  const wrapped = {
    list: () => inner.list(),
    get: (id: string) => inner.get(id),
    getByUrl: (url: string) => inner.getByUrl(url),
    save: async (c: KnowledgeCard) => { counters.writes += 1; await inner.save(c) },
    // 删除本身也是一次整表事务（锁 + 读盘 + 原子写），与逐张 save 同口径计数
    delete: async (id: string) => { counters.writes += 1; return await inner.delete(id) },
    ...(opts.exposeBatch
      ? { saveMany: async (cs: readonly KnowledgeCard[]) => { counters.writes += 1; await inner.saveMany?.(cs) } }
      : {}),
  } as KnowledgeCardStore
  return { store: wrapped, counters }
}

/** 目标卡 + follower 张引用它的卡 + 3 张无关卡，写进真实文件 store。 */
async function seed(file: string, followers: number): Promise<KnowledgeCardStore> {
  const store = createFileKnowledgeCardStore(file)
  await store.save(card('kc_target'))
  for (let i = 0; i < followers; i += 1) {
    await store.save(card(`kc_f${String(i).padStart(3, '0')}`, { related: ['kc_target'] }))
  }
  for (let i = 0; i < 3; i += 1) await store.save(card(`kc_x${i}`))
  return store
}

describe('管理员证伪下架一张被大量引用的知识卡片', () => {
  it('管理员下架被 40 张卡引用的卡片时，只有一次批量落盘而非每张一次', async () => {
    // Given：一张被 40 张卡片引用、另有 3 张无关卡的真实文件库
    const file = tempFile('cards.json')
    const inner = await seed(file, 40)
    const { store, counters } = countingStore(inner, { exposeBatch: true })
    const tool = createKnowledgeDeleteTool(store)

    // When：下架目标卡
    const result = await tool.execute({ id: 'kc_target' })

    // Then：清理 40 张引用方 + 删除本身 = 2 次落盘（优化前为 40 + 1 = 41 次）
    expect(result).toContain('已删除卡片')
    expect(result).toContain('已清理 40 张卡片的 related 引用')
    expect(counters.writes).toBe(2)
  })

  it('管理员下架的 store 没有批量通道时，降级为逐张落盘且结果一致', async () => {
    // Given：同一个被 40 张卡引用的真实文件库，但 store 不暴露 saveMany
    const file = tempFile('cards.json')
    const inner = await seed(file, 40)
    const { store, counters } = countingStore(inner, { exposeBatch: false })
    const tool = createKnowledgeDeleteTool(store)

    // When：下架目标卡
    const result = await tool.execute({ id: 'kc_target' })

    // Then：退回逐张写（41 次），引用清理结果不变
    expect(result).toContain('已清理 40 张卡片的 related 引用')
    expect(counters.writes).toBe(41)
    const remaining = await inner.list()
    // 库中原有 44 张（1 目标 + 40 引用方 + 3 无关），下架后剩 43
    expect(remaining).toHaveLength(43)
    expect(remaining.every((c) => !(c.related ?? []).includes('kc_target'))).toBe(true)
  })

  it('管理员下架后，批量通道与逐张通道留下的库内容逐值相同', async () => {
    // Given：同样的库，分别走批量通道与逐张通道
    const batchInner = await seed(tempFile('batch.json'), 12)
    const batch = countingStore(batchInner, { exposeBatch: true })
    await createKnowledgeDeleteTool(batch.store).execute({ id: 'kc_target' })

    const plainInner = await seed(tempFile('plain.json'), 12)
    const plain = countingStore(plainInner, { exposeBatch: false })
    await createKnowledgeDeleteTool(plain.store).execute({ id: 'kc_target' })

    // Then：两条通道的最终库逐值一致（updatedAt 除外——它是写入时刻）
    const strip = (cards: readonly KnowledgeCard[]) => cards
      .map((c) => ({ ...c, updatedAt: '' }))
      .sort((a, b) => a.id.localeCompare(b.id))
    expect(strip(await batchInner.list())).toEqual(strip(await plainInner.list()))
    expect(batch.counters.writes).toBe(2)
    expect(plain.counters.writes).toBe(13)
  })
})
