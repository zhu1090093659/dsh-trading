/**
 * 资产台账 file store 跨实例并发写（2026-10-09 事故同类）：桌面端与 CLI 各录入一条
 * 持仓时，双方都要留在盘上，且 revision 连续不回退。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileHoldingsStore } from '../src/store-fs.ts'

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

async function freshFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-holdings-concurrency-'))
  tmpDirs.push(dir)
  return path.join(dir, 'book.json')
}

describe('资产台账 file store 跨实例并发写', () => {
  it('用户在第二个实例录入持仓时，第一个实例先录入的持仓不丢', async () => {
    // Given 两个实例都已读入同一份空台账
    const file = await freshFile()
    const desktop = createFileHoldingsStore(file)
    const cli = createFileHoldingsStore(file)
    expect((await desktop.snapshot()).holdings).toEqual([])
    expect((await cli.snapshot()).holdings).toEqual([])

    // When 桌面端先录入一条，CLI 再录入另一条
    await desktop.add({ market: 'us', symbol: 'AAPL', size: 10 })
    await cli.add({ market: 'hk', symbol: '00700.HK', size: 200 })

    // Then 磁盘两条都在，且 revision 为 2（没有用陈旧 revision 覆盖）
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { revision: number; holdings: Array<{ symbol: string }> }
    expect(onDisk.holdings.map(h => h.symbol).sort()).toEqual(['00700.HK', 'AAPL'])
    expect(onDisk.revision).toBe(2)
  })
})
