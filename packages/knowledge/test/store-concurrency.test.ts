/**
 * 知识卡片 file store 跨实例并发写（2026-10-09 事故同类）：桌面端与 CLI 各写一张
 * 卡片时，双方都要留在盘上。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileKnowledgeCardStore } from '../src/knowledge-fs.ts'
import type { KnowledgeCard } from '../src/types.ts'

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

async function freshFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-knowledge-concurrency-'))
  tmpDirs.push(dir)
  return path.join(dir, 'cards.json')
}

function card(id: string): KnowledgeCard {
  return {
    id,
    title: `Card ${id}`,
    summary: 'Summary text',
    source: { type: 'bilibili', url: `https://bilibili.com/video/${id}`, author: 'UP' },
    credibility: 'high',
    coreClaims: ['C1'],
    factCheck: { verified: ['V1'], discrepancies: [], unverifiable: [] },
    takeaways: ['T1'],
    boundaries: ['B1'],
    tags: ['Tag1'],
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
  }
}

describe('知识卡片 file store 跨实例并发写', () => {
  it('用户在第二个实例入库新卡片时，第一个实例先入库的卡片不丢', async () => {
    // Given 两个实例都已读入同一份空快照
    const file = await freshFile()
    const desktop = createFileKnowledgeCardStore(file)
    const cli = createFileKnowledgeCardStore(file)
    expect(await desktop.list()).toEqual([])
    expect(await cli.list()).toEqual([])

    // When 桌面端先入库一张，CLI 再入库另一张
    await desktop.save(card('kc_desktop_1'))
    await cli.save(card('kc_cli_1'))

    // Then 磁盘两张都在
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Array<{ id: string }>
    expect(onDisk.map(c => c.id).sort()).toEqual(['kc_cli_1', 'kc_desktop_1'])
  })
})
