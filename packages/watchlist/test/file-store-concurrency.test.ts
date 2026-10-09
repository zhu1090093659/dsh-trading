/**
 * 自选/分组/选中三个 file store 的跨实例并发写（2026-10-09 事故同类）；
 * 自选行是种子基线合并视图，先铺满盘再让两个实例并发写。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileSelectionStore, createFileWatchlistGroupsStore, createFileWatchlistStore } from '../src/file-store.ts'

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

async function freshFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-watchlist-concurrency-'))
  tmpDirs.push(dir)
  return path.join(dir, name)
}

describe('自选行 file store 跨实例并发写', () => {
  it('用户在两个实例各加一行时，两行都落盘（先铺满盘避免回落种子）', async () => {
    // Given 已有非空的 us / hk 行，两个实例各自读入
    const file = await freshFile('watchlists.json')
    const seed = createFileWatchlistStore(file)
    await seed.add('us', { market: 'us', symbol: 'AAPL', name: '苹果' })
    await seed.add('hk', { market: 'hk', symbol: '00700.HK', name: '腾讯' })
    const desktop = createFileWatchlistStore(file)
    const cli = createFileWatchlistStore(file)
    expect((await desktop.list()).us).toHaveLength(1)

    // When 桌面端给 us 追加一行，CLI 给 hk 追加一行
    expect(await desktop.add('us', { market: 'us', symbol: 'TSLA' })).toBe(true)
    expect(await cli.add('hk', { market: 'hk', symbol: '02714.HK' })).toBe(true)

    // Then 磁盘上 us 两条、hk 两条都在
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, Array<{ symbol: string }>>
    expect(onDisk.us.map(r => r.symbol)).toEqual(['AAPL', 'TSLA'])
    expect(onDisk.hk.map(r => r.symbol)).toEqual(['00700.HK', '02714.HK'])
  })
})

describe('分组注册表 file store 跨实例并发写', () => {
  it('用户在两个实例各建一个分组时，两个分组都落盘', async () => {
    // Given 两个实例都已读入同一份空注册表
    const file = await freshFile('watchlist-groups.json')
    const desktop = createFileWatchlistGroupsStore(file)
    const cli = createFileWatchlistGroupsStore(file)
    expect(await desktop.list()).toEqual([])

    // When 桌面端先建一个，CLI 再建另一个
    const first = await desktop.create('总持仓')
    const second = await cli.create('观察池')
    expect(first.group).toBeDefined()
    expect(second.group).toBeDefined()

    // Then 磁盘两个分组都在
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { groups: Array<{ name: string }> }
    expect(onDisk.groups.map(g => g.name).sort()).toEqual(['总持仓', '观察池'])
  })
})

describe('选中标的 file store 跨实例并发写', () => {
  it('用户在第二个实例选中新标的后，磁盘为后写者值', async () => {
    // Given 两个实例都已读入同一份空选中
    const file = await freshFile('selection.json')
    const desktop = createFileSelectionStore(file)
    const cli = createFileSelectionStore(file)
    expect((await desktop.get()).instrument).toBeNull()

    // When 桌面端先选，CLI 再选另一个
    await desktop.set({ instrument: { market: 'us', symbol: 'AAPL' } })
    await cli.set({ instrument: { market: 'hk', symbol: '00700.HK' } })

    // Then 磁盘是后写者（单值语义，不看合并）
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { instrument: { symbol: string } }
    expect(onDisk.instrument.symbol).toBe('00700.HK')
    expect((await createFileSelectionStore(file).get()).instrument?.symbol).toBe('00700.HK')
  })
})
