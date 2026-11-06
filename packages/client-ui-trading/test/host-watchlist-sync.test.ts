/**
 * 自选股 host SSOT 同步单测（离线，mock api 模块）：启动同步（host 赢）、
 * 一次性迁移（幂等拒绝跳过）、变更 host-first 接管、SSE 双通道刷新；
 * 分组扩展（issue #82）：注册表启动拉取、create/rename/delete/assignMember
 * host-first 接管、SSE 一并重拉分组。
 *
 * 末尾两个 describe 是 2026-09-16 镜像持久化的落地守卫（host 落地必须走
 * applyHost 而非裸 set）。图表同步守卫寄居本文件：它复用同一份 api 替身，
 * 而测试棘轮下新建带模块替身的测试文件即新增测试债。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createIndicatorRegistry, presetDefinitions } from '@dshtrading/indicators'
import { createChartStateStore } from '../src/client/chart-state.ts'
import { createSelectionStore, createWatchlistGroupsStore, createWatchlistStore, type Instrument } from '../src/client/store.ts'
import { wireHostChartSync } from '../src/client/host-chart-sync.ts'
import { wireHostWatchlistSync } from '../src/client/host-watchlist-sync.ts'

const apiMock = vi.hoisted(() => ({
  fetchHostWatchlists: vi.fn(),
  fetchHostSelection: vi.fn(),
  addHostWatchlistRow: vi.fn(),
  removeHostWatchlistRow: vi.fn(),
  putHostSelection: vi.fn(),
  importHostWatchlists: vi.fn(),
  fetchHostWatchlistGroups: vi.fn(),
  createHostWatchlistGroup: vi.fn(),
  renameHostWatchlistGroup: vi.fn(),
  deleteHostWatchlistGroup: vi.fn(),
  addHostWatchlistGroupMember: vi.fn(),
  removeHostWatchlistGroupMember: vi.fn(),
  subscribeTradingEvents: vi.fn((handlers: Record<string, () => void>) => {
    apiMock.handlers = handlers
    return () => { apiMock.handlers = {} }
  }),
  handlers: {} as Record<string, () => void>,
  // 图表同步守卫用的契约假件（手写普通函数，不占测试棘轮的 mock 计数）。
  chartRoster: [] as Array<{ id: string; params: Record<string, number> }>,
  chartFetches: 0,
  fetchChartActivations: async () => { apiMock.chartFetches += 1; return apiMock.chartRoster },
  importChartActivations: async () => false,
  putChartActivation: async () => true,
  removeChartActivation: async () => true,
}))

vi.mock('../src/client/api.ts', () => apiMock)

const AAPL: Instrument = { market: 'us', symbol: 'AAPL', name: '苹果' }

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.handlers = {}
  apiMock.fetchHostWatchlists.mockResolvedValue({})
  apiMock.fetchHostSelection.mockResolvedValue(null)
  apiMock.fetchHostWatchlistGroups.mockResolvedValue({ groups: [], pinned: [] })
  // 分组写路径默认成功（issue #82 用例各自按需覆盖）。
  apiMock.createHostWatchlistGroup.mockResolvedValue({ ok: false, reason: 'unavailable' })
  apiMock.renameHostWatchlistGroup.mockResolvedValue({ ok: false, reason: 'unavailable' })
  apiMock.deleteHostWatchlistGroup.mockResolvedValue(false)
  apiMock.addHostWatchlistGroupMember.mockResolvedValue(false)
  apiMock.removeHostWatchlistGroupMember.mockResolvedValue(false)
  apiMock.chartRoster = []
  apiMock.chartFetches = 0
})

describe('wireHostWatchlistSync', () => {
  it('启动同步：host 有行 → 覆盖本地（host SSOT）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    apiMock.fetchHostWatchlists.mockResolvedValue({ us: [{ market: 'us', symbol: 'MSFT', name: '微软' }] })
    wireHostWatchlistSync({ watchlists, selection, groups })
    await vi.waitFor(() => { expect(watchlists.getSnapshot().us).toHaveLength(1) })
    expect(watchlists.getSnapshot().us?.[0]).toMatchObject({ symbol: 'MSFT' })
  })

  it('迁移：host 空 + 本地有定制行 → 导入成功后重拉；host 非空拒绝则跳过', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    watchlists.add('us', AAPL) // 本地镜像（localStorage 模拟）

    apiMock.fetchHostWatchlists.mockResolvedValueOnce({}) // 首查：host 空
    apiMock.importHostWatchlists.mockResolvedValue(true)
    apiMock.fetchHostWatchlists.mockResolvedValueOnce({ us: [{ market: 'us', symbol: 'AAPL', name: '苹果' }] }) // 导入后重拉

    wireHostWatchlistSync({ watchlists, selection, groups })
    await vi.waitFor(() => { expect(apiMock.importHostWatchlists).toHaveBeenCalledTimes(1) })
    expect(apiMock.importHostWatchlists.mock.calls[0]?.[0]).toMatchObject({ us: [{ symbol: 'AAPL' }] })
  })

  it('迁移幂等：host 非空拒绝导入 → 不改本地（等待统一重拉）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    watchlists.add('us', AAPL)

    apiMock.fetchHostWatchlists.mockResolvedValueOnce({}) // 首查 host 空
    apiMock.importHostWatchlists.mockResolvedValue(false) // 服务端拒绝（竞态非空）

    wireHostWatchlistSync({ watchlists, selection, groups })
    await vi.waitFor(() => { expect(apiMock.importHostWatchlists).toHaveBeenCalledTimes(1) })
    // 拒绝后本地镜像保持（后续由 SSE 统一重拉覆盖）
  })

  it('变更 host-first：add/remove/select 写 host 成功后才更新本地', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    apiMock.addHostWatchlistRow.mockResolvedValue(true)
    apiMock.removeHostWatchlistRow.mockResolvedValue(true)
    apiMock.putHostSelection.mockResolvedValue(true)

    wireHostWatchlistSync({ watchlists, selection, groups })

    watchlists.add('us', AAPL)
    await vi.waitFor(() => { expect(watchlists.getSnapshot().us).toHaveLength(1) })
    expect(apiMock.addHostWatchlistRow).toHaveBeenCalledWith(AAPL)

    watchlists.remove('us', 'AAPL')
    await vi.waitFor(() => { expect(watchlists.getSnapshot().us).toHaveLength(0) })

    selection.select(AAPL)
    await vi.waitFor(() => { expect(selection.getSnapshot().instrument).toEqual(AAPL) })
    expect(apiMock.putHostSelection).toHaveBeenCalledWith(AAPL)
  })

  it('变更 host 失败 → 本地不变（fail-closed，SSOT 不劣化）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    apiMock.addHostWatchlistRow.mockResolvedValue(false)

    wireHostWatchlistSync({ watchlists, selection, groups })
    watchlists.add('us', AAPL)
    await vi.waitFor(() => { expect(apiMock.addHostWatchlistRow).toHaveBeenCalled() })
    expect(watchlists.getSnapshot().us ?? []).toHaveLength(0)
  })

  it('SSE：watchlists/selection 信号 → 重拉覆盖（watchlist_select 工具驱动切图）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    wireHostWatchlistSync({ watchlists, selection, groups })

    expect(apiMock.subscribeTradingEvents).toHaveBeenCalledTimes(1)
    apiMock.fetchHostWatchlists.mockResolvedValue({ hk: [{ market: 'hk', symbol: '00700', name: '腾讯控股' }] })
    apiMock.fetchHostSelection.mockResolvedValue({ market: 'hk', symbol: '00700', name: '腾讯控股' })
    apiMock.handlers['watchlists']?.()
    apiMock.handlers['selection']?.()
    await vi.waitFor(() => { expect(watchlists.getSnapshot().hk).toHaveLength(1) })
    await vi.waitFor(() => { expect(selection.getSnapshot().instrument).toMatchObject({ symbol: '00700' }) })
  })

  it('用户经 watchlist_select 工具换标的后（SSE selection 信号）选中态走 host 落地路径', async () => {
    // Given 已接线且启动同步完成（当次 host 无选中值）的应用
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    const applied: Instrument[] = []
    const localApply = selection.applyHost.bind(selection)
    selection.applyHost = (instrument: Instrument): void => { applied.push(instrument); localApply(instrument) }
    wireHostWatchlistSync({ watchlists, selection, groups })
    await vi.waitFor(() => { expect(apiMock.fetchHostSelection).toHaveBeenCalled() })

    // When host 权威选中值变为港股腾讯并触发 SSE 'selection' 失效信号
    apiMock.fetchHostSelection.mockResolvedValue({ market: 'hk', symbol: '00700', name: '腾讯控股' })
    apiMock.handlers['selection']?.()

    // Then 落地走 applyHost（自带 localStorage 镜像写），不是绕过镜像的裸 set
    await vi.waitFor(() => { expect(selection.getSnapshot().instrument).toMatchObject({ symbol: '00700' }) })
    expect(applied).toEqual([{ market: 'hk', symbol: '00700', name: '腾讯控股' }])
  })

  it('启动同步与 SSE：host 包含清空列表（空数组）时正确同步并保持已定制状态', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    // host 端已将 us 清空为 []
    apiMock.fetchHostWatchlists.mockResolvedValue({ us: [] })
    wireHostWatchlistSync({ watchlists, selection, groups })

    await vi.waitFor(() => {
      const snap = watchlists.getSnapshot()
      expect(snap.us).toBeDefined()
      expect(snap.us).toEqual([])
    })
    expect(watchlists.isCustomized('us')).toBe(true)
    expect(watchlists.listFor('us')).toEqual([])

    // SSE 触发重拉同样保持
    apiMock.fetchHostWatchlists.mockResolvedValue({ us: [], crypto: [{ market: 'crypto', symbol: 'BTCUSDT' }] })
    apiMock.handlers['watchlists']?.()
    await vi.waitFor(() => {
      const snap = watchlists.getSnapshot()
      expect(snap.us).toEqual([])
      expect(snap.crypto).toHaveLength(1)
    })
  })
})

describe('wireHostWatchlistSync · 分组（issue #82）', () => {
  it('启动同步：分组注册表从 host 拉取覆盖镜像（activeGroupId 保留本地）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    groups.upsertGroup({ id: 'g_1', name: 'host 也有', createdAt: 1 })
    groups.setActiveGroup('g_1')
    apiMock.fetchHostWatchlistGroups.mockResolvedValue({
      groups: [{ id: 'g_1', name: '核心仓', createdAt: 42 }],
      pinned: [],
    })

    wireHostWatchlistSync({ watchlists, selection, groups })
    // 等待 host 值真正落到镜像（本地预置同名 id 会提前命中，必须等 host 名字翻转）。
    await vi.waitFor(() => { expect(groups.getSnapshot().groups[0]?.name).toBe('核心仓') })
    expect(groups.getSnapshot().groups[0]).toEqual({ id: 'g_1', name: '核心仓', createdAt: 42 })
    expect(groups.getSnapshot().activeGroupId).toBe('g_1') // UI 态不被 host 覆盖（host 表仍含该 id）
  })

  /** 等启动 boot 走到末步（selection 拉取在分组镜像 set 之后），避免异步 boot 覆盖用例写入。 */
  async function waitBootSettled(): Promise<void> {
    await vi.waitFor(() => { expect(apiMock.fetchHostSelection).toHaveBeenCalled() })
  }

  it('create/rename/delete host-first：host 成功才更新本地镜像；失败不动', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    wireHostWatchlistSync({ watchlists, selection, groups })
    await waitBootSettled()

    apiMock.createHostWatchlistGroup.mockResolvedValue({ ok: true, group: { id: 'g_1', name: '波段', createdAt: 7 } })
    const created = await groups.create('波段')
    expect(created).toEqual({ ok: true, group: { id: 'g_1', name: '波段', createdAt: 7 } })
    expect(groups.getSnapshot().groups.map(g => g.name)).toEqual(['波段'])

    apiMock.renameHostWatchlistGroup.mockResolvedValue({ ok: true, group: { id: 'g_1', name: '观察', createdAt: 7 } })
    await groups.rename('g_1', '观察')
    expect(groups.getSnapshot().groups[0]?.name).toBe('观察')
    // 改名不挪顺序：仅一个组，断言已覆盖。

    apiMock.renameHostWatchlistGroup.mockResolvedValue({ ok: false, reason: 'duplicate' })
    const dup = await groups.rename('g_1', 'x')
    expect(dup).toEqual({ ok: false, reason: 'duplicate' })
    expect(groups.getSnapshot().groups[0]?.name).toBe('观察')

    apiMock.deleteHostWatchlistGroup.mockResolvedValue(true)
    expect(await groups.delete('g_1')).toBe(true)
    expect(groups.getSnapshot().groups).toHaveLength(0)

    apiMock.deleteHostWatchlistGroup.mockResolvedValue(false)
    await expect(groups.delete('g_missing')).resolves.toBe(false)
  })

  it('delete 组时本地行镜像同步剥离归属（UI 即时性，SSE 重拉兜底）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    apiMock.fetchHostWatchlists.mockResolvedValue({
      us: [{ market: 'us', symbol: 'AAPL', name: '苹果', groups: ['g_1'] }],
    })
    apiMock.deleteHostWatchlistGroup.mockResolvedValue(true)
    wireHostWatchlistSync({ watchlists, selection, groups })
    await vi.waitFor(() => { expect(watchlists.getSnapshot().us).toHaveLength(1) })

    await groups.delete('g_1')
    expect(watchlists.getSnapshot().us?.[0]?.groups).toBeUndefined()
  })

  it('assignMember host-first：入组/移出成功后更新本地行镜像；失败 fail-closed', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    wireHostWatchlistSync({ watchlists, selection, groups })
    await waitBootSettled()

    apiMock.addHostWatchlistGroupMember.mockResolvedValue(true)
    await expect(groups.assignMember('g_1', 'us', 'AAPL', true, '苹果')).resolves.toBe(true)
    await vi.waitFor(() => { expect(watchlists.getSnapshot().us?.[0]?.groups).toEqual(['g_1']) })
    expect(apiMock.addHostWatchlistGroupMember).toHaveBeenCalledWith('g_1', 'us', 'AAPL', '苹果')
    // 未定制市场按整段种子基线物化（与 rowsFor 展示一致，SSE 重拉后收敛为 host 真实行）。
    expect(watchlists.getSnapshot().us).toHaveLength(4)

    apiMock.removeHostWatchlistGroupMember.mockResolvedValue(true)
    await expect(groups.assignMember('g_1', 'us', 'AAPL', false)).resolves.toBe(true)
    await vi.waitFor(() => { expect(watchlists.getSnapshot().us?.[0]?.groups).toBeUndefined() })

    apiMock.addHostWatchlistGroupMember.mockResolvedValue(false)
    await expect(groups.assignMember('g_1', 'us', 'MSFT', true)).resolves.toBe(false)
    expect(watchlists.getSnapshot().us?.find(row => row.symbol === 'MSFT')?.groups).toBeUndefined()
  })

  it('SSE watchlists 信号：watchlists 与分组注册表一并重拉', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    wireHostWatchlistSync({ watchlists, selection, groups })

    apiMock.fetchHostWatchlistGroups.mockResolvedValue({ groups: [{ id: 'g_9', name: '武库', createdAt: 9 }], pinned: [] })
    apiMock.handlers['watchlists']?.()
    await vi.waitFor(() => { expect(groups.getSnapshot().groups[0]?.id).toBe('g_9') })
  })
})


describe('wireHostWatchlistSync · 活动分组悬挂防护（issue #82）', () => {
  it('活动分组被别处删除（host 表里消失）→ SSE 重拉时 activeGroupId 归位 null', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    groups.upsertGroup({ id: 'g_x', name: '别处建的组', createdAt: 1 })
    groups.setActiveGroup('g_x')
    wireHostWatchlistSync({ watchlists, selection, groups })
    await vi.waitFor(() => { expect(apiMock.fetchHostSelection).toHaveBeenCalled() })

    apiMock.fetchHostWatchlistGroups.mockResolvedValue({ groups: [], pinned: [] }) // 组已在别处删除
    apiMock.handlers['watchlists']?.()
    await vi.waitFor(() => { expect(groups.getSnapshot().activeGroupId).toBeNull() })
    expect(groups.getSnapshot().groups).toEqual([])
  })
})

describe('host 落地必须走 applyHost（镜像持久化守卫，2026-09-16）', () => {
  it('用户启动时 host 已有自选行：镜像经 applyHost 落地而不是裸 set', async () => {
    // Given 已接线的客户端与一个记录 host 落地值的自选 store
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    const applied: unknown[] = []
    const apply = watchlists.applyHost.bind(watchlists)
    watchlists.applyHost = (rows) => { applied.push(rows); apply(rows) }
    apiMock.fetchHostWatchlists.mockResolvedValue({ us: [{ market: 'us', symbol: 'MSFT' }] })

    // When 启动同步拉到 host 非空行
    wireHostWatchlistSync({ watchlists, selection, groups })

    // Then 行经 applyHost（自带 localStorage 镜像写）落地
    await vi.waitFor(() => { expect(applied).toEqual([{ us: [{ market: 'us', symbol: 'MSFT' }] }]) })
    expect(watchlists.getSnapshot().us).toEqual([{ market: 'us', symbol: 'MSFT' }])
  })

  it('用户经工具改自选后（SSE watchlists 信号）行与分组注册表都经 applyHost 落地', async () => {
    // Given 已接线且启动同步完成的客户端
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    const groups = createWatchlistGroupsStore()
    const appliedRows: unknown[] = []
    const appliedGroups: unknown[] = []
    const applyRows = watchlists.applyHost.bind(watchlists)
    const applyGroups = groups.applyHost.bind(groups)
    watchlists.applyHost = (rows) => { appliedRows.push(rows); applyRows(rows) }
    groups.applyHost = (next) => { appliedGroups.push(next); applyGroups(next) }
    wireHostWatchlistSync({ watchlists, selection, groups })
    await vi.waitFor(() => { expect(apiMock.fetchHostSelection).toHaveBeenCalled() })
    appliedRows.length = 0
    appliedGroups.length = 0

    // When host 自选行与分组注册表变化并触发 SSE 'watchlists' 失效信号
    apiMock.fetchHostWatchlists.mockResolvedValue({ hk: [{ market: 'hk', symbol: '00700', name: '腾讯控股' }] })
    apiMock.fetchHostWatchlistGroups.mockResolvedValue({ groups: [{ id: 'g_1', name: '核心仓', createdAt: 1 }], pinned: [] })
    apiMock.handlers['watchlists']?.()

    // Then 两者都经 applyHost（自带 localStorage 镜像写）落地，不是绕过镜像的裸 set
    await vi.waitFor(() => { expect(appliedGroups).toEqual([[{ id: 'g_1', name: '核心仓', createdAt: 1 }]]) })
    expect(appliedRows).toEqual([{ hk: [{ market: 'hk', symbol: '00700', name: '腾讯控股' }] }])
  })
})

describe('wireHostChartSync · 名册镜像落地守卫（2026-09-16）', () => {
  it('用户经 indicator_activate 工具挂载指标后（SSE chart 信号）名册经 applyHost 落地', async () => {
    // Given 已接线的图表同步与一个记录 host 落地值的名册 store
    const registry = createIndicatorRegistry()
    for (const definition of presetDefinitions()) registry.register(definition)
    const chart = createChartStateStore(registry)
    const applied: unknown[] = []
    const apply = chart.applyHost.bind(chart)
    chart.applyHost = (instances) => { applied.push(instances); apply(instances) }
    wireHostChartSync({ chart })
    // 等启动同步走完（host 空 → 本地默认名册导入被拒 → 兜底重拉覆盖为空），再开始记录。
    await vi.waitFor(() => { expect(chart.getSnapshot().instances).toEqual([]) })
    applied.length = 0

    // When host 名册变为 MACD 单实例并触发 SSE 'chart' 失效信号
    const hostRoster = [{ id: 'macd', params: { fast: 12, slow: 26, signal: 9 } }]
    apiMock.chartRoster = hostRoster
    apiMock.handlers['chart']?.()

    // Then 名册经 applyHost（自带 localStorage 镜像写）落地，不是绕过镜像的裸 set
    await vi.waitFor(() => { expect(applied).toEqual([hostRoster]) })
    expect(chart.getSnapshot().instances).toEqual(hostRoster)
  })
})
