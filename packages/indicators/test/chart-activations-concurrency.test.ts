/**
 * 跨实例并发写回归（2026-10-09 事故）：同一路径的两个 file store 实例各自持有
 * 整表缓存，各自整表回写——后写者若用自己那份陈旧快照覆盖，会静默抹掉先写者的数据。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileChartActivationStore } from '../src/chart-activations-fs.js'

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

async function freshFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-chart-concurrency-'))
  tmpDirs.push(dir)
  return path.join(dir, 'chart.json')
}

describe('file store 跨实例并发写', () => {
  it('用户从第二个实例写新指标时，第一个实例先写的指标不丢', async () => {
    // Given 两个实例都已启动并读入同一份空快照（桌面端 + CLI 共用同一 home）
    const file = await freshFile()
    const desktop = createFileChartActivationStore(file)
    const cli = createFileChartActivationStore(file)
    expect(await desktop.list()).toEqual([])
    expect(await cli.list()).toEqual([])

    // When 桌面端先写主动买盘指标，CLI 再写另一个指标
    await desktop.activate({ id: 'active_buy_real', params: { n: 1 }, symbolParams: { 'hk:00700.HK': { n: 2 } } })
    await cli.activate({ id: 'ema', params: { n: 20 } })

    // Then 磁盘上两个指标都在——后写者不得用陈旧快照覆盖先写者的数据
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Array<{ id: string }>
    expect(onDisk.map(i => i.id).sort()).toEqual(['active_buy_real', 'ema'])
    expect((await createFileChartActivationStore(file).list()).map(i => i.id).sort())
      .toEqual(['active_buy_real', 'ema'])
  })
})
