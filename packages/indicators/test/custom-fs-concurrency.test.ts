/**
 * 自定义指标 file store 跨实例并发写（2026-10-09 事故同类）：两个实例各持整表
 * 缓存、各自整表回写时，后写者不得用陈旧快照覆盖先写者的数据。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileCustomIndicatorStore } from '../src/custom-fs.ts'
import type { CustomIndicatorRecord } from '../src/custom.ts'

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

async function freshFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-custom-ind-concurrency-'))
  tmpDirs.push(dir)
  return path.join(dir, 'custom.json')
}

function record(id: string): CustomIndicatorRecord {
  return { id, title: id, pane: 'sub', params: [], computeSource: '(bars) => []', createdAt: 1 }
}

describe('自定义指标 file store 跨实例并发写', () => {
  it('用户在第二个实例写新指标时，第一个实例先写的指标不丢', async () => {
    // Given 两个实例都已读入同一份空快照
    const file = await freshFile()
    const desktop = createFileCustomIndicatorStore(file)
    const cli = createFileCustomIndicatorStore(file)
    expect(await desktop.list()).toEqual([])
    expect(await cli.list()).toEqual([])

    // When 桌面端先写一个指标，CLI 再写另一个
    await desktop.save(record('active_buy_real'))
    await cli.save(record('td9'))

    // Then 磁盘两条都在
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Array<{ id: string }>
    expect(onDisk.map(r => r.id).sort()).toEqual(['active_buy_real', 'td9'])
  })

  it('用户分别在两个实例删除不同指标时，两条删除都落盘', async () => {
    // Given 已落盘三个指标，两个实例各自读入
    const file = await freshFile()
    const seed = createFileCustomIndicatorStore(file)
    await seed.save(record('a_ind'))
    await seed.save(record('b_ind'))
    await seed.save(record('keep_ind'))
    const desktop = createFileCustomIndicatorStore(file)
    const cli = createFileCustomIndicatorStore(file)
    expect((await desktop.list()).length).toBe(3)

    // When 两个实例各删一个
    expect(await desktop.remove('a_ind')).toBe(true)
    expect(await cli.remove('b_ind')).toBe(true)

    // Then 删除不被对方的新增/旧快照复活，只剩 keep_ind
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Array<{ id: string }>
    expect(onDisk.map(r => r.id)).toEqual(['keep_ind'])
  })
})
