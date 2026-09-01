/**
 * 自定义策略 file store 单测（离线，tmp 目录）：save/list/get/remove 往返、
 * 跨实例持久化（tmp+rename 落盘语义）、原子写无残留。
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileCustomStrategyStore } from '../src/custom-fs.ts'
import type { CustomStrategyRecord } from '../src/custom.ts'

const RECORD: CustomStrategyRecord = {
  id: 'demo-fs',
  title: '演示策略',
  horizon: 'short',
  summary: '演示用',
  paramsJson: '[{"key":"n","label":"n","default":5,"min":1,"max":10}]',
  computeSource: '(bars) => []',
  createdAt: 1700000000000,
}

describe('createFileCustomStrategyStore', () => {
  it('save → list/get 往返；跨实例读取（持久化落盘）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-strategies-'))
    const filePath = join(dir, 'custom.json')
    const store = createFileCustomStrategyStore(filePath)
    await store.save(RECORD)

    const reread = createFileCustomStrategyStore(filePath)
    expect(await reread.get('demo-fs')).toEqual(RECORD)
    expect((await reread.list()).map(r => r.id)).toEqual(['demo-fs'])
  })

  it('remove 返回是否 existed；删除后跨实例可见', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-strategies-'))
    const filePath = join(dir, 'custom.json')
    const store = createFileCustomStrategyStore(filePath)
    await store.save(RECORD)
    expect(await store.remove('demo-fs')).toBe(true)
    expect(await store.remove('demo-fs')).toBe(false)

    const reread = createFileCustomStrategyStore(filePath)
    expect(await reread.get('demo-fs')).toBeUndefined()
  })

  it('坏 JSON 文件 → 空库兜底（不炸启动）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-strategies-'))
    const filePath = join(dir, 'custom.json')
    const store = createFileCustomStrategyStore(filePath)
    await store.save(RECORD)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, '{corrupt', 'utf8')
    const reread = createFileCustomStrategyStore(filePath)
    expect(await reread.list()).toEqual([])
  })

  it('原子写：flush 后目录无 .tmp 残留，落盘为合法 JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-strategies-'))
    const filePath = join(dir, 'custom.json')
    const store = createFileCustomStrategyStore(filePath)
    await store.save(RECORD)
    const files = await readdir(dir)
    expect(files.filter(f => f.includes('.tmp.'))).toEqual([])
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as CustomStrategyRecord[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ id: 'demo-fs' })
  })
})
