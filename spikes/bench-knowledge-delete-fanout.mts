/**
 * 知识库删除的引用清理扇出：knowledge_delete 先扫全表找引用方，再逐卡 save。
 * 每次 save 都是一次整表事务（锁 + 读盘 + 序列化 + 原子写）。
 *
 * 运行：pnpm exec tsx spikes/bench-knowledge-delete-fanout.mts
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { createFileKnowledgeCardStore } from '../packages/knowledge/src/knowledge-fs.ts'
import { createKnowledgeDeleteTool } from '../packages/knowledge/src/tool.ts'
import type { KnowledgeCard, KnowledgeCardStore } from '../packages/knowledge/src/types.ts'

function card(id: string, related: string[] = []): KnowledgeCard {
  return {
    id, title: 'Card ' + id, summary: 'Summary text',
    source: { type: 'bilibili', url: 'https://bilibili.com/video/' + id, author: 'UP', publishedAt: '2026-08-30' },
    credibility: 'high', coreClaims: ['C1'], factCheck: { verified: [], discrepancies: [], unverifiable: [] },
    takeaways: [], boundaries: [], tags: ['Tag1'],
    ...(related.length > 0 ? { related } : {}),
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
  }
}
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }

const root = await mkdtemp(path.join(os.tmpdir(), 'bench-kn-del-'))
try {
  for (const followers of [0, 40, 120]) {
    const times: number[] = []
    let saves = 0
    let usedBatch = false
    for (let r = 0; r < 9; r++) {
      const file = path.join(root, `cards-${followers}-${r}.json`)
      const inner = createFileKnowledgeCardStore(file)
      // 目标卡 + F 张引用它的卡 + 10 张无关卡
      await inner.save(card('kc_target'))
      for (let i = 0; i < followers; i++) await inner.save(card('kc_f' + i, ['kc_target']))
      for (let i = 0; i < 10; i++) await inner.save(card('kc_x' + i))
      saves = 0
      usedBatch = false
      // 计数包装：saveMany 计 1 次整表落盘（与真实文件 store 的事务次数同口径），
      // 并把调用交给内层——批量通道存在时删除只应触发 1 次写。
      const counting: KnowledgeCardStore = {
        list: () => inner.list(), get: (id) => inner.get(id), getByUrl: (u) => inner.getByUrl(u),
        save: async (c) => { saves += 1; await inner.save(c) },
        saveMany: async (cs) => { usedBatch = true; saves += 1; await inner.saveMany?.(cs) },
        delete: (id) => inner.delete(id),
      } as unknown as KnowledgeCardStore
      const tool = createKnowledgeDeleteTool(counting)
      const t = performance.now()
      await tool.execute({ id: 'kc_target' })
      times.push(performance.now() - t)
    }
    console.log(JSON.stringify({
      path: 'knowledge_delete', followerCards: followers, tableSize: followers + 11, rounds: 9,
      rawMs: times.map((x) => +x.toFixed(1)), medianMs: +median(times).toFixed(1),
      wholeTableWrites: saves + 1, batchChannel: usedBatch,
    }))
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
