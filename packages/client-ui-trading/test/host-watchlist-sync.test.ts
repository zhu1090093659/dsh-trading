/**
 * 自选股 host SSOT 同步单测（离线，mock api 模块）：启动同步（host 赢）、
 * 一次性迁移（幂等拒绝跳过）、变更 host-first 接管、SSE 双通道刷新。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSelectionStore, createWatchlistStore, type Instrument } from '../src/client/store.ts'
import { wireHostWatchlistSync } from '../src/client/host-watchlist-sync.ts'

const apiMock = vi.hoisted(() => ({
  fetchHostWatchlists: vi.fn(),
  fetchHostSelection: vi.fn(),
  addHostWatchlistRow: vi.fn(),
  removeHostWatchlistRow: vi.fn(),
  putHostSelection: vi.fn(),
  importHostWatchlists: vi.fn(),
  subscribeTradingEvents: vi.fn((handlers: Record<string, () => void>) => {
    apiMock.handlers = handlers
    return () => { apiMock.handlers = {} }
  }),
  handlers: {} as Record<string, () => void>,
}))

vi.mock('../src/client/api.ts', () => apiMock)

const AAPL: Instrument = { market: 'us', symbol: 'AAPL', name: '苹果' }

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.handlers = {}
  apiMock.fetchHostWatchlists.mockResolvedValue({})
  apiMock.fetchHostSelection.mockResolvedValue(null)
})

describe('wireHostWatchlistSync', () => {
  it('启动同步：host 有行 → 覆盖本地（host SSOT）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    apiMock.fetchHostWatchlists.mockResolvedValue({ us: [{ market: 'us', symbol: 'MSFT', name: '微软' }] })
    wireHostWatchlistSync({ watchlists, selection })
    await vi.waitFor(() => { expect(watchlists.getSnapshot().us).toHaveLength(1) })
    expect(watchlists.getSnapshot().us?.[0]).toMatchObject({ symbol: 'MSFT' })
  })

  it('迁移：host 空 + 本地有定制行 → 导入成功后重拉；host 非空拒绝则跳过', async () => {
    const watchlists = createWatchlistStore()
    watchlists.add('us', AAPL) // 本地镜像（localStorage 模拟）
    const selection = createSelectionStore()

    apiMock.fetchHostWatchlists.mockResolvedValueOnce({}) // 首查：host 空
    apiMock.importHostWatchlists.mockResolvedValue(true)
    apiMock.fetchHostWatchlists.mockResolvedValueOnce({ us: [{ market: 'us', symbol: 'AAPL', name: '苹果' }] }) // 导入后重拉

    wireHostWatchlistSync({ watchlists, selection })
    await vi.waitFor(() => { expect(apiMock.importHostWatchlists).toHaveBeenCalledTimes(1) })
    expect(apiMock.importHostWatchlists.mock.calls[0]?.[0]).toMatchObject({ us: [{ symbol: 'AAPL' }] })
  })

  it('迁移幂等：host 非空拒绝导入 → 不改本地（等待统一重拉）', async () => {
    const watchlists = createWatchlistStore()
    watchlists.add('us', AAPL)
    const selection = createSelectionStore()

    apiMock.fetchHostWatchlists.mockResolvedValueOnce({}) // 首查 host 空
    apiMock.importHostWatchlists.mockResolvedValue(false) // 服务端拒绝（竞态非空）

    wireHostWatchlistSync({ watchlists, selection })
    await vi.waitFor(() => { expect(apiMock.importHostWatchlists).toHaveBeenCalledTimes(1) })
    // 拒绝后本地镜像保持（后续由 SSE 统一重拉覆盖）
  })

  it('变更 host-first：add/remove/select 写 host 成功后才更新本地', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    apiMock.addHostWatchlistRow.mockResolvedValue(true)
    apiMock.removeHostWatchlistRow.mockResolvedValue(true)
    apiMock.putHostSelection.mockResolvedValue(true)

    wireHostWatchlistSync({ watchlists, selection })

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
    apiMock.addHostWatchlistRow.mockResolvedValue(false)

    wireHostWatchlistSync({ watchlists, selection })
    watchlists.add('us', AAPL)
    await vi.waitFor(() => { expect(apiMock.addHostWatchlistRow).toHaveBeenCalled() })
    expect(watchlists.getSnapshot().us ?? []).toHaveLength(0)
  })

  it('SSE：watchlists/selection 信号 → 重拉覆盖（watchlist_select 工具驱动切图）', async () => {
    const watchlists = createWatchlistStore()
    const selection = createSelectionStore()
    wireHostWatchlistSync({ watchlists, selection })

    expect(apiMock.subscribeTradingEvents).toHaveBeenCalledTimes(1)
    apiMock.fetchHostWatchlists.mockResolvedValue({ hk: [{ market: 'hk', symbol: '00700', name: '腾讯控股' }] })
    apiMock.fetchHostSelection.mockResolvedValue({ market: 'hk', symbol: '00700', name: '腾讯控股' })
    apiMock.handlers['watchlists']?.()
    apiMock.handlers['selection']?.()
    await vi.waitFor(() => { expect(watchlists.getSnapshot().hk).toHaveLength(1) })
    await vi.waitFor(() => { expect(selection.getSnapshot().instrument).toMatchObject({ symbol: '00700' }) })
  })
})
