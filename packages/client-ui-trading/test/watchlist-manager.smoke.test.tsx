/**
 * 自选管理弹窗渲染冒烟（issue #82 审查补充）：真正 mount 进 jsdom，拦「构建与逻辑单测
 * 全绿、一渲染就崩」类回归（对照 2026-09-03 QuoteStage TDZ 教训）。
 *
 * 覆盖：
 * - 分组清单 / 标的表 / 组内 chips 渲染不抛错；
 * - 无市场上下文的手输标的按代码形态推断市场（审查修正：此前恒落 crypto）；
 * - 活动分组被别处删除 → 范围归位「全部」，不再被悬挂 id 过滤成空表（审查修正）。
 *
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { createWatchlistGroupsStore, createWatchlistStore, type Watchlists } from '../src/client/store.ts'
import { WatchlistManager } from '../src/client/WatchlistManager.tsx'
import type { MarketId } from '../src/client/types.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

/** 内存版 localStorage 假件（跨文件 stub 可能残留，这里显式装全量面）。 */
const storage = new Map<string, string>()
function installStorage(): void {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
    clear: () => { storage.clear() },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size },
  })
}

beforeEach(() => {
  installStorage()
  // 断网桩：桥请求一律失败，markets 保持 FALLBACK、在线检索静默降级。
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderManager(setup?: {
  groups?: Array<{ id: string; name: string; createdAt: number }>
  rows?: Record<string, Array<{ market: string; symbol: string; name?: string; groups?: string[] }>>
}) {
  const watchlists = createWatchlistStore()
  for (const [market, rows] of Object.entries(setup?.rows ?? {})) {
    for (const row of rows) watchlists.add(market as MarketId, row as never)
  }
  const groups = createWatchlistGroupsStore()
  for (const group of setup?.groups ?? []) groups.upsertGroup(group)
  const added: Array<{ market: string; symbol: string; groups?: string[] }> = []
  const props = {
    t,
    useWatchlists: <T,>(sel: (value: Watchlists) => T): T => sel(watchlists.getSnapshot()),
    useWatchlistGroups: <T,>(sel: (value: ReturnType<typeof groups.getSnapshot>) => T): T => sel(groups.getSnapshot()),
    addInstrument: (market: MarketId, instrument: { symbol: string; groups?: string[] }) => {
      added.push({ market, symbol: instrument.symbol, ...(instrument.groups !== undefined ? { groups: instrument.groups } : {}) })
    },
    removeInstrument: () => {},
    createGroup: async () => ({ ok: false as const, reason: 'unavailable' as const }),
    renameGroup: async () => ({ ok: false as const, reason: 'unavailable' as const }),
    deleteGroup: async () => false,
    assignGroupMember: async () => true,
    onClose: () => {},
  }
  return { ...render(<WatchlistManager {...props} />), added, groups }
}

describe('WatchlistManager 渲染冒烟', () => {
  it('渲染分组清单 + 标的表 + 组内 chip；手输无命中标的按形态推断市场', async () => {
    const { added, getAllByText, getByText, getByPlaceholderText, container } = renderManager({
      groups: [{ id: 'g1', name: '核心仓', createdAt: 1 }],
      rows: { us: [{ market: 'us', symbol: 'AAPL', name: '苹果', groups: ['g1'] }] },
    })
    expect(getByText('manager.title')).toBeTruthy()
    // 左栏分组行 + 右栏行上 chip 各一处
    expect(getAllByText('核心仓')).toHaveLength(2)
    expect(getByText('AAPL')).toBeTruthy()
    expect(getByText('苹果')).toBeTruthy()

    // 手输本地字典未收录的美股代码 → 推断 us（修正前恒落 crypto）
    const input = getByPlaceholderText('manager.addPlaceholder')
    fireEvent.change(input, { target: { value: 'PLTR' } })
    await act(async () => { fireEvent.submit(container.querySelector('form.paneAdd') ?? input) })
    await waitFor(() => { expect(added).toEqual([{ market: 'us', symbol: 'PLTR' }]) })

    // 港股数字形态 → hk 规范形
    fireEvent.change(input, { target: { value: '700' } })
    await act(async () => { fireEvent.submit(container.querySelector('form.paneAdd') ?? input) })
    await waitFor(() => { expect(added).toEqual([{ market: 'us', symbol: 'PLTR' }, { market: 'hk', symbol: '00700.HK' }]) })
  })

  it('活动分组被别处删除 → 范围归位全部（不再被悬挂 id 过滤成空表）', async () => {
    const { getAllByText, getByText, groups } = renderManager({
      groups: [{ id: 'g1', name: '核心仓', createdAt: 1 }],
      rows: { us: [{ market: 'us', symbol: 'AAPL', name: '苹果', groups: ['g1'] }] },
    })
    // 进入分组范围（点左栏分组行；行上 chip 同名，用 closest('button') 区分）
    const railRow = getAllByText('核心仓').map(el => el.closest('button')).find(btn => btn !== null)
    expect(railRow).toBeTruthy()
    fireEvent.click(railRow as HTMLElement)
    await waitFor(() => { expect(getByText('AAPL')).toBeTruthy() })

    // 别处删除该分组（SSE 重拉/另一标签页）→ 行仍在（范围归位「全部」）
    act(() => { groups.removeGroupLocal('g1') })
    await waitFor(() => { expect(getByText('AAPL')).toBeTruthy() })
    expect(getByText('group.all')).toBeTruthy()
  })
})
