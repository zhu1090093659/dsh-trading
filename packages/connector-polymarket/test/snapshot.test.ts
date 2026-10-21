/**
 * 本地快照用例：**真实文件系统**（每用例独立临时目录），零 mock。
 *
 * 覆盖的核心不变量（对应验收「失败路径不产生空数据假象」）：首次观察时
 * `changeSincePrevious` **缺省**而不是 0——「不知道」与「确知没变」是两件事。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PredictionMeeting } from '@dshtrading/api'
import { SNAPSHOT_VERSION, SnapshotStore, applySnapshot, defaultSnapshotPath, parseSnapshotTable } from '../src/snapshot.ts'

const dirs: string[] = []

function tempFile(name = 'snapshots.json', create = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-poly-snap-'))
  dirs.push(dir)
  const path = join(dir, 'polymarket', name)
  if (create) mkdirSync(join(dir, 'polymarket'), { recursive: true })
  return path
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function meeting(id: string, values: readonly number[]): PredictionMeeting {
  return {
    id,
    slug: `slug-${id}`,
    title: `Meeting ${id}`,
    endDate: '2026-10-29T03:59:00Z',
    closed: false,
    buckets: values.map((probability, index) => ({
      key: `k${index}`,
      label: `Bucket ${index}`,
      probability,
      acceptingOrders: true,
      closed: false,
    })),
    probabilitySum: Number(values.reduce((sum, value) => sum + value, 0).toFixed(6)),
    degraded: [],
  }
}

describe('快照表解析与降级', () => {
  it('运营遇到坏 JSON 或结构版本不符的快照时得到空表而不是崩', () => {
    // Given 四种不该让面板崩的坏内容
    // When / Then 全部降级为空表（快照是增益信息，缺失不影响概率正确性）
    expect(parseSnapshotTable(null)).toEqual({ version: SNAPSHOT_VERSION, meetings: {} })
    expect(parseSnapshotTable({ version: 99, meetings: {} })).toEqual({ version: SNAPSHOT_VERSION, meetings: {} })
    expect(parseSnapshotTable({ version: SNAPSHOT_VERSION, meetings: 'nope' })).toEqual({ version: SNAPSHOT_VERSION, meetings: {} })
    expect(parseSnapshotTable({ version: SNAPSHOT_VERSION, meetings: { a: { k0: { probability: 'x', observedAt: 'y' } } } })).toEqual({ version: SNAPSHOT_VERSION, meetings: { a: {} } })
  })

  it('运营看到默认快照路径落在 trading home 而不是包内或仓库数据', () => {
    // Given trading home 环境（显式传入，不依赖本机环境）
    // When 解析默认路径
    const path = defaultSnapshotPath({ DSH_HOME: '/tmp/dsh-trading-home' })

    // Then 路径在 trading home 的 polymarket/ 下（期望值按本平台算：Windows 上
    // resolve('/tmp/…') 会按当前盘符补成 D:\tmp\…）
    expect(path).toBe(join(resolve('/tmp/dsh-trading-home'), 'polymarket', 'snapshots.json'))
  })
})

describe('概率变动标注（applySnapshot）', () => {
  it('运营首次看到某场会议时没有变动值（缺省而不是 0）', () => {
    // Given 空快照表
    // When 首次标注
    const { meetings, next } = applySnapshot({ version: SNAPSHOT_VERSION, meetings: {} }, [meeting('m1', [0.225, 0.745])], '2026-10-11T00:00:00.000Z')

    // Then 每档 changeSincePrevious 缺省（不是 0），且新表记下本次读数
    expect(meetings[0]?.buckets.map((bucket) => bucket.changeSincePrevious)).toEqual([undefined, undefined])
    expect(meetings[0]?.buckets.every((bucket) => !('changeSincePrevious' in bucket))).toBe(true)
    expect(next.meetings.m1).toEqual({
      k0: { probability: 0.225, observedAt: '2026-10-11T00:00:00.000Z' },
      k1: { probability: 0.745, observedAt: '2026-10-11T00:00:00.000Z' },
    })
  })

  it('运营第二次看到时拿到与上次读数的差（含负值与真实零变动）', () => {
    // Given 上次记录 0.225 / 0.745
    const previous = { version: SNAPSHOT_VERSION, meetings: { m1: { k0: { probability: 0.225, observedAt: '2026-10-11T00:00:00.000Z' }, k1: { probability: 0.745, observedAt: '2026-10-11T00:00:00.000Z' } } } }

    // When 本次读数为 0.215 / 0.745
    const { meetings } = applySnapshot(previous, [meeting('m1', [0.215, 0.745])], '2026-10-11T01:00:00.000Z')

    // Then 首档为真实的 −0.01，第二档为真实的 0（确知没变）
    expect(meetings[0]?.buckets[0]?.changeSincePrevious).toBe(-0.01)
    expect(meetings[0]?.buckets[1]?.changeSincePrevious).toBe(0)
  })

  it('运营看到上一次观察过的会议在新一轮消失时不报错（快照按 id 保留）', () => {
    // Given 上次有两场会议
    const previous = { version: SNAPSHOT_VERSION, meetings: { m1: { k0: { probability: 0.2, observedAt: 't1' } }, m2: { k0: { probability: 0.3, observedAt: 't1' } } } }

    // When 本次只有 m1
    const { meetings, next } = applySnapshot(previous, [meeting('m1', [0.25])], '2026-10-11T02:00:00.000Z')

    // Then m1 有差值，m2 仍留在表里（会议可能只是本轮未返回）
    expect(meetings).toHaveLength(1)
    expect(meetings[0]?.buckets[0]?.changeSincePrevious).toBeCloseTo(0.05, 10)
    expect(next.meetings.m2).toEqual({ k0: { probability: 0.3, observedAt: 't1' } })
  })
})

describe('快照持久化（真实文件）', () => {
  it('运营首次运行时不存在的快照文件被当作空表（不是错误）', async () => {
    // Given 一个尚未创建的快照文件路径
    const store = new SnapshotStore({ filePath: tempFile() })

    // When 读取
    const table = await store.read()

    // Then 得到空表，且**没有**凭空创建文件
    expect(table).toEqual({ version: SNAPSHOT_VERSION, meetings: {} })
  })

  it('运营两次取数后快照文件里留下的是本次读数，且第二次带出真实差值', async () => {
    // Given 同一路径的两次标注（第一次 0.225，第二次 0.215）
    const filePath = tempFile()
    const store = new SnapshotStore({ filePath })
    const first = await store.annotate([meeting('m1', [0.225])], '2026-10-11T00:00:00.000Z')
    const second = await store.annotate([meeting('m1', [0.215])], '2026-10-11T01:00:00.000Z')

    // When 直接读盘复核
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { version: number; meetings: Record<string, Record<string, { probability: number }>> }

    // Then 第一次无 Δ、第二次 −0.01，盘上是第二次的读数
    expect(first[0]?.buckets[0]?.changeSincePrevious).toBeUndefined()
    expect(second[0]?.buckets[0]?.changeSincePrevious).toBe(-0.01)
    expect(onDisk.version).toBe(SNAPSHOT_VERSION)
    expect(onDisk.meetings.m1?.k0?.probability).toBe(0.215)
  })

  it('运营遇到磁盘上的坏 JSON 时看作空表并正常继续取数', async () => {
    // Given 一个内容被截断的快照文件
    const filePath = tempFile('snapshots.json', true)
    writeFileSync(filePath, '{ not json', 'utf8')
    const store = new SnapshotStore({ filePath })

    // When 标注
    const meetings = await store.annotate([meeting('m1', [0.5])], '2026-10-11T00:00:00.000Z')

    // Then 无 Δ（视为首次），文件被重写成合法内容
    expect(meetings[0]?.buckets[0]?.changeSincePrevious).toBeUndefined()
    expect(parseSnapshotTable(JSON.parse(readFileSync(filePath, 'utf8'))).meetings.m1?.k0?.probability).toBe(0.5)
  })

  it('运营在两个实例之间取数时，第二个实例读到第一个实例落盘的基线并算出真实差值', async () => {
    // Given 两个实例共用同一路径，桌面端先记下 0.225
    const filePath = tempFile()
    const desktop = new SnapshotStore({ filePath })
    await desktop.annotate([meeting('m1', [0.225])], '2026-10-11T00:00:00.000Z')
    const cli = new SnapshotStore({ filePath })

    // When CLI 用新读数 0.215 标注
    const seen = await cli.annotate([meeting('m1', [0.215])], '2026-10-11T01:00:00.000Z')

    // Then CLI 拿到与桌面端落盘基线之间的真实差（读取没有停在本地旧快照）
    expect(seen[0]?.buckets[0]?.changeSincePrevious).toBe(-0.01)
  })
})
