/**
 * 自选置顶键集单测（2026-11-05 用户裁决「自选列表按涨跌幅排序 + 标的置顶」）：内存与
 * 文件两个分组 store 实现。置顶键集与分组注册表同容器、同文件、同一实例，因此本文件
 * 钉住三件事：幂等写（同状态再写返回 false 且不落盘）、键清洗（`market:symbol` 之外的
 * 一律拒绝）、以及 pinned 与 groups 在同一份 JSON 里共存（含只有 `{groups:[]}` 的老文件
 * 升级路径）。stripPinned 是删行时的防僵尸置顶钩子，单独覆盖「只清目标键」。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createMemorySelectionStore,
  createMemoryWatchlistGroupsStore,
  createMemoryWatchlistStore,
  normalizePinnedKey,
  watchlistRowKey,
} from '../src/index.ts'
import { createFileWatchlistGroupsStore } from '../src/file-store.ts'
import { createWatchlistRemoveTool, type WatchlistToolDeps } from '../src/plugin.ts'

/** 每个用例一个独立临时目录里的文件（与 groups.test.ts 同款，真落盘）。 */
async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-watchlist-pins-'))
  return join(dir, name)
}

/** 读回盘上的 JSON（断言落盘形状用；坏文件直接让用例炸，不静默）。 */
async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
}

describe('normalizePinnedKey（置顶键清洗）', () => {
  it('用户提交不成形的置顶键时，空串/无冒号/空段/非字符串一律拒绝', () => {
    // Given 一组不成形的键候选：空串、纯空白、没有冒号、冒号在首/尾、非字符串类型
    const rejected: unknown[] = ['', '   ', 'nocolon', ':x', 'x:', ':x:', 42, null, undefined, { key: 'us:AAPL' }, ['us:AAPL']]
    // When 逐条清洗
    const cleaned = rejected.map(raw => normalizePinnedKey(raw))
    // Then 全部 null（坏值不落盘）
    expect(cleaned).toEqual(rejected.map(() => null))
  })

  it('用户提交合法的 market:symbol 键时，清洗保真（去首尾空白、符号里的冒号不截断）', () => {
    // Given 合法键、带首尾空白的合法键、符号本身含冒号的键
    // When 逐条清洗
    // Then 去空白后原样返回，多冒号键不被截断（与客户端 rowKey 同源格式）
    expect(normalizePinnedKey('us:AAPL')).toBe('us:AAPL')
    expect(normalizePinnedKey('  hk:00700  ')).toBe('hk:00700')
    expect(normalizePinnedKey('crypto:BTC:USDT')).toBe('crypto:BTC:USDT')
    expect(watchlistRowKey('us', 'AAPL')).toBe('us:AAPL')
  })
})

describe('memory groups store（置顶）', () => {
  it('用户把同一标的重复置顶时，第二次返回 false 且键集只有一条（幂等）', async () => {
    // Given 一个空的内存分组 store
    const store = createMemoryWatchlistGroupsStore()
    // When 同一标的连续置顶两次
    const first = await store.setPinned('us:AAPL', true)
    const second = await store.setPinned('us:AAPL', true)
    // Then 第一次生效、第二次 no-op，键集不出现重复
    expect([first, second]).toEqual([true, false])
    expect(await store.pinned()).toEqual(['us:AAPL'])
  })

  it('用户把同一标的重复取消置顶时，第二次返回 false 且键集保持空（幂等）', async () => {
    // Given 一个已置顶 us:AAPL 的内存分组 store
    const store = createMemoryWatchlistGroupsStore([], ['us:AAPL'])
    // When 连续取消置顶两次
    const first = await store.setPinned('us:AAPL', false)
    const second = await store.setPinned('us:AAPL', false)
    // Then 第一次生效、第二次 no-op，键集为空
    expect([first, second]).toEqual([true, false])
    expect(await store.pinned()).toEqual([])
  })

  it('用户用坏键置顶时全部被拒绝，键集保持为空（坏值不落盘）', async () => {
    // Given 一个空的内存分组 store
    const store = createMemoryWatchlistGroupsStore()
    // When 依次用四种坏键置顶
    const results = await Promise.all(['', 'nocolon', ':x', 'x:'].map(key => store.setPinned(key, true)))
    // Then 全部返回 false，键集仍为空
    expect(results).toEqual([false, false, false, false])
    expect(await store.pinned()).toEqual([])
  })

  it('用户置顶两个标的后取消其中一个时，另一个仍在且顺序不变', async () => {
    // Given 一个空的内存分组 store
    const store = createMemoryWatchlistGroupsStore()
    // When 依次置顶美股苹果与港股腾讯，再取消置顶苹果
    await store.setPinned('us:AAPL', true)
    await store.setPinned('hk:00700', true)
    const before = await store.pinned()
    const changed = await store.setPinned('us:AAPL', false)
    // Then 置顶顺序按写入保序，取消只摘掉目标键
    expect(before).toEqual(['us:AAPL', 'hk:00700'])
    expect(changed).toBe(true)
    expect(await store.pinned()).toEqual(['hk:00700'])
  })

  it('用户从含重复与坏键的初始键集构造 store 时，清洗去重且保序', async () => {
    // Given 一个初始置顶键集：重复键、无冒号键、空段键混在合法键之间
    const store = createMemoryWatchlistGroupsStore([], ['us:AAPL', 'us:AAPL', 'nocolon', ':x', 'hk:00700'])
    // When 读取键集
    // Then 坏键剔除、重复合并，合法键保序
    expect(await store.pinned()).toEqual(['us:AAPL', 'hk:00700'])
  })

  it('用户移出自选行（stripPinned）时只清目标键，未知键返回 false', async () => {
    // Given 一个已置顶美股苹果与港股腾讯的内存分组 store
    const store = createMemoryWatchlistGroupsStore([], ['us:AAPL', 'hk:00700'])
    // When 先用与删行同源的键清苹果，再重复清一次，最后清一个不成形的键
    const stripped = await store.stripPinned(watchlistRowKey('us', 'AAPL'))
    const again = await store.stripPinned('us:AAPL')
    const malformed = await store.stripPinned('nocolon')
    // Then 只有第一次改动生效，另一个键原样保留
    expect([stripped, again, malformed]).toEqual([true, false, false])
    expect(await store.pinned()).toEqual(['hk:00700'])
  })
})

describe('file groups store（置顶与分组同文件）', () => {
  it('用户先建分组再置顶后重读时，分组与置顶在同一份文件里共存', async () => {
    // Given 一个临时目录里的空分组文件
    const filePath = await tempFile('watchlist-groups.json')
    const store = createFileWatchlistGroupsStore(filePath)
    // When 先建一个分组，再把一个标的置顶
    const created = await store.create('核心仓')
    const pinnedWritten = await store.setPinned('us:AAPL', true)
    // Then 新实例同时读回两者，盘上同一份 JSON 里两个数组都在
    expect(created.group?.name).toBe('核心仓')
    expect(pinnedWritten).toBe(true)
    const reread = createFileWatchlistGroupsStore(filePath)
    expect((await reread.list()).map(group => group.name)).toEqual(['核心仓'])
    expect(await reread.pinned()).toEqual(['us:AAPL'])
    const onDisk = await readJsonFile(filePath)
    expect((onDisk.groups as Array<{ name: string }>).map(group => group.name)).toEqual(['核心仓'])
    expect(onDisk.pinned).toEqual(['us:AAPL'])
  })

  it('用户从只有 groups 键的老文件升级时，置顶读出空数组且分组保留', async () => {
    // Given 一个老版本落盘形状（只有 groups 键，没有 pinned 键）
    const filePath = await tempFile('watchlist-groups.json')
    await writeFile(filePath, JSON.stringify({ groups: [{ id: 'g_old', name: '老分组', createdAt: 1 }] }), 'utf8')
    // When 新版 store 打开它
    const store = createFileWatchlistGroupsStore(filePath)
    // Then 置顶为空数组（零迁移），老分组原样在位
    expect(await store.pinned()).toEqual([])
    expect((await store.list()).map(group => group.id)).toEqual(['g_old'])
  })

  it('用户取消最后一个置顶后，盘上文件不再写 pinned 键（空集不落键）', async () => {
    // Given 一个已置顶 us:AAPL 的文件分组 store
    const filePath = await tempFile('watchlist-groups.json')
    const store = createFileWatchlistGroupsStore(filePath)
    await store.setPinned('us:AAPL', true)
    const pinnedOnDisk = (await readJsonFile(filePath)).pinned
    // When 取消这条置顶
    const changed = await store.setPinned('us:AAPL', false)
    // Then 键集空 → 落盘形状里 pinned 键整个消失（只留 groups）
    expect(pinnedOnDisk).toEqual(['us:AAPL'])
    expect(changed).toBe(true)
    const onDisk = await readJsonFile(filePath)
    expect(onDisk.pinned).toBeUndefined()
    expect(Object.keys(onDisk)).toEqual(['groups'])
  })

  it('用户对同一状态重复置顶或清一个未置顶键时，不重写文件（手写的非规范 JSON 逐字不变）', async () => {
    // Given 一份手写的非规范 JSON（缩进/空行都不是写路径的规范形）——若走整份重写，
    //        encode + JSON.stringify(…, null, 2) 会把它重新序列化成 2 空格规范形。
    const filePath = await tempFile('watchlist-groups.json')
    const handWritten = '{\n    "groups": [],\n\n    "pinned": [ "us:AAPL" ]\n}\n'
    await writeFile(filePath, handWritten, 'utf8')
    const store = createFileWatchlistGroupsStore(filePath)
    // Given 前置（同一 Given 的一部分）：这份手写文件真的被读懂了，不是读失败降级成空表
    expect(await store.pinned()).toEqual(['us:AAPL'])
    // When 再置顶同一标的（同状态），并清一个从未置顶的键
    const changed = await store.setPinned('us:AAPL', true)
    const stripped = await store.stripPinned('us:TSLA')
    // Then 两次都是 no-op，且文件一个字节都没被重写（SKIP_WRITE 哨兵挡住了整份重写）
    expect([changed, stripped]).toEqual([false, false])
    expect(await readFile(filePath, 'utf8')).toBe(handWritten)
    // And 正向对照：真正的写入会把同一份数据重写成规范形——证明上面比的是「没写」而不是
    //     「重写了但内容等价」
    expect(await store.setPinned('hk:00700', true)).toBe(true)
    expect(await readFile(filePath, 'utf8'))
      .toBe(JSON.stringify({ groups: [], pinned: ['us:AAPL', 'hk:00700'] }, null, 2))
  })

  it('用户移出自选行（stripPinned）时只清目标键，未知键返回 false 且盘上不变', async () => {
    // Given 一个已置顶两个标的的文件分组 store
    const filePath = await tempFile('watchlist-groups.json')
    const store = createFileWatchlistGroupsStore(filePath)
    await store.setPinned('us:AAPL', true)
    await store.setPinned('hk:00700', true)
    // When 用删行同源的键清苹果，再清一个从未置顶的键
    const stripped = await store.stripPinned(watchlistRowKey('us', 'AAPL'))
    const strippedOnDisk = (await readJsonFile(filePath)).pinned
    const beforeUnknown = await readFile(filePath, 'utf8')
    const unknown = await store.stripPinned('us:TSLA')
    // Then 只有目标键被摘掉，未知键不改盘
    expect(stripped).toBe(true)
    expect(strippedOnDisk).toEqual(['hk:00700'])
    expect(unknown).toBe(false)
    expect(await readFile(filePath, 'utf8')).toBe(beforeUnknown)
  })

  it('用户手改文件塞进重复与坏置顶键时，读盘清洗为合法键且保序', async () => {
    // Given 一份被手工改坏的分组文件（重复键 + 三种坏键混在合法键之间）
    const filePath = await tempFile('watchlist-groups.json')
    await writeFile(
      filePath,
      JSON.stringify({ groups: [], pinned: ['us:AAPL', 'us:AAPL', 'nocolon', ':x', 'x:', 'hk:00700'] }),
      'utf8',
    )
    // When 新版 store 读盘
    // Then 坏键剔除、重复合并，合法键保序（面板不会被垃圾键带崩）
    expect(await createFileWatchlistGroupsStore(filePath).pinned()).toEqual(['us:AAPL', 'hk:00700'])
  })

  it('用户在新实例里读同一文件时，置顶键集跨实例可见', async () => {
    // Given 一个文件分组 store 写入两个置顶键
    const filePath = await tempFile('watchlist-groups.json')
    const store = createFileWatchlistGroupsStore(filePath)
    await store.setPinned('us:AAPL', true)
    await store.setPinned('hk:00700', true)
    // When 同进程另建的一个实例（同路径、同一份锁内新鲜读盘）读回
    const reread = createFileWatchlistGroupsStore(filePath)
    // Then 两个键按写入顺序原样可见
    expect(await reread.pinned()).toEqual(['us:AAPL', 'hk:00700'])
  })
})

describe('watchlist_remove 工具（agent 删行清置顶）', () => {
  it('用户经 agent 工具删掉一条已置顶的行时，该行的置顶键被清掉且不误伤同名键', async () => {
    // Given 自选（未定制 → 种子基线）与置顶键集「美股苹果 + 美股特斯拉」，其中特斯拉行已不在表里
    const watchlists = createMemoryWatchlistStore()
    const groups = createMemoryWatchlistGroupsStore([], ['us:AAPL', 'us:TSLA'])
    let changes = 0
    const deps: WatchlistToolDeps = {
      watchlists,
      selection: createMemorySelectionStore(),
      groups,
      onWatchlistsChanged: () => { changes += 1 },
    }
    const tool = createWatchlistRemoveTool(deps)
    // When 工具删掉苹果这一行
    const removed = (await tool.execute({ market: 'us', symbol: 'AAPL' })) as { ok: boolean; removed: boolean }
    // Then 行真的没了、苹果的置顶键被清掉而特斯拉的键留下，且发了一次 watchlists 变更信号
    expect(removed).toMatchObject({ ok: true, removed: true })
    expect((await watchlists.list()).us?.map(row => row.symbol)).toEqual(['MSFT', 'NVDA', 'GOOGL'])
    expect(await groups.pinned()).toEqual(['us:TSLA'])
    expect(changes).toBe(1)

    // When 工具再删一行本来就不在表里的标的（它的置顶键还在）
    const missing = (await tool.execute({ market: 'us', symbol: 'TSLA' })) as { ok: boolean; removed: boolean }
    // Then removed 为假 → 不清键（避免误伤同名键），也不再发变更信号
    expect(missing).toMatchObject({ ok: true, removed: false })
    expect(await groups.pinned()).toEqual(['us:TSLA'])
    expect(changes).toBe(1)
  })

  it('用户经 agent 工具删掉一条未置顶的行时，置顶键集原样不变', async () => {
    // Given 自选（种子基线）与只置顶了美股苹果的键集
    const watchlists = createMemoryWatchlistStore()
    const groups = createMemoryWatchlistGroupsStore([], ['us:AAPL'])
    const deps: WatchlistToolDeps = { watchlists, selection: createMemorySelectionStore(), groups }
    const tool = createWatchlistRemoveTool(deps)
    // When 工具删掉未置顶的微软
    const removed = (await tool.execute({ market: 'us', symbol: 'MSFT' })) as { ok: boolean; removed: boolean }
    // Then 行没了，苹果的置顶键一个不少（stripPinned 只动目标键）
    expect(removed).toMatchObject({ ok: true, removed: true })
    expect((await watchlists.list()).us?.map(row => row.symbol)).toEqual(['AAPL', 'NVDA', 'GOOGL'])
    expect(await groups.pinned()).toEqual(['us:AAPL'])
  })
})

