/**
 * 策略/选股器/墓碑三个 file store 的跨实例并发写（2026-10-09 事故同类）：
 * 桌面端与 CLI 各写一条时，双方都要留在盘上，后写者不得用陈旧快照覆盖。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileCustomStrategyStore } from '../src/custom-fs.ts'
import { createFileCustomScreenerStore } from '../src/custom-screener-fs.ts'
import { createFileBuiltinTombstonesStore } from '../src/builtin-tombstones-fs.ts'
import type { CustomStrategyRecord } from '../src/custom.ts'
import type { CustomScreenerRecord } from '../src/custom-screener.ts'

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

async function freshFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-strategies-concurrency-'))
  tmpDirs.push(dir)
  return path.join(dir, name)
}

function strategy(id: string): CustomStrategyRecord {
  return { id, title: id, horizon: 'swing', summary: 's', paramsJson: '[]', computeSource: '(bars) => []', createdAt: 1 }
}

function screener(id: string): CustomScreenerRecord {
  return {
    id, title: id, horizon: 'swing', summary: 's', paramsJson: '[]',
    columnsJson: '[]', evaluateSource: '(bars) => null', createdAt: 1,
  }
}

describe('自定义策略 file store 跨实例并发写', () => {
  it('用户在第二个实例保存策略时，第一个实例先保存的策略不丢', async () => {
    // Given 两个实例都已读入同一份空快照
    const file = await freshFile('custom.json')
    const desktop = createFileCustomStrategyStore(file)
    const cli = createFileCustomStrategyStore(file)
    expect(await desktop.list()).toEqual([])
    expect(await cli.list()).toEqual([])

    // When 桌面端先保存一条，CLI 再保存另一条
    await desktop.save(strategy('strat-desktop'))
    await cli.save(strategy('strat-cli'))

    // Then 磁盘两条都在
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Array<{ id: string }>
    expect(onDisk.map(r => r.id).sort()).toEqual(['strat-cli', 'strat-desktop'])
  })
})

describe('自定义选股器 file store 跨实例并发写', () => {
  it('用户在第二个实例保存选股器时，第一个实例先保存的选股器不丢', async () => {
    // Given 两个实例都已读入同一份空快照
    const file = await freshFile('custom-screeners.json')
    const desktop = createFileCustomScreenerStore(file)
    const cli = createFileCustomScreenerStore(file)
    expect(await desktop.list()).toEqual([])
    expect(await cli.list()).toEqual([])

    // When 桌面端先保存一条，CLI 再保存另一条
    await desktop.save(screener('scr.desktop'))
    await cli.save(screener('scr.cli'))

    // Then 磁盘两条都在
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Array<{ id: string }>
    expect(onDisk.map(r => r.id).sort()).toEqual(['scr.cli', 'scr.desktop'])
  })
})

describe('内置墓碑 file store 跨实例并发写', () => {
  it('用户在两个实例各删除一个内置策略时，两条墓碑都留下', async () => {
    // Given 两个实例都已读入同一份空墓碑表
    const file = await freshFile('builtin-tombstones.json')
    const desktop = createFileBuiltinTombstonesStore(file)
    const cli = createFileBuiltinTombstonesStore(file)
    expect(await desktop.list()).toEqual([])
    expect(await cli.list()).toEqual([])

    // When 桌面端先删一条，CLI 再删另一条
    expect(await desktop.add('donchian-breakout')).toBe(true)
    expect(await cli.add('scr.ma-bull-align')).toBe(true)

    // Then 磁盘两条墓碑都在
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { deleted: string[] }
    expect([...onDisk.deleted].sort()).toEqual(['donchian-breakout', 'scr.ma-bull-align'])
  })
})
