/**
 * 自选管理弹窗渲染冒烟（issue #82 审查补充）：真正 mount 进 jsdom，拦「构建与逻辑单测
 * 全绿、一渲染就崩」类回归（对照 2026-09-03 QuoteStage TDZ 教训）。
 *
 * 覆盖：
 * - 分组清单 / 标的表 / 组内 chips 渲染不抛错；
 * - 无市场上下文的手输标的按代码形态推断市场（审查修正：此前恒落 crypto）：
 *   字典命中与「字典无命中」两条路径分开断言——只断言字典命中时
 *   inferInputMarket 从未被执行（PLTR/700 都先被本地字典接走）；
 * - 活动分组被别处删除 → 范围归位「全部」，不再被悬挂 id 过滤成空表（审查修正）：
 *   用例内含组外行，回退到悬挂 id 过滤时该行会被误藏。
 *
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { createWatchlistGroupsStore, createWatchlistStore, type Watchlists } from '../src/client/store.ts'
import { WatchlistManager } from '../src/client/WatchlistManager.tsx'
import type { MarketId } from '../src/client/types.ts'

/**
 * 字典命中开关：置 true 时 searchAllMarkets 恒空，强制走「无命中 → 形态推断」分支；
 * 默认透传真字典，保证「字典命中」用例仍走真实路径。
 */
const catalog = vi.hoisted(() => ({ empty: false }))

vi.mock('../src/client/symbol-catalog.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/symbol-catalog.ts')>()
  return {
    ...actual,
    searchAllMarkets: (query: string) => (catalog.empty ? [] : actual.searchAllMarkets(query)),
  }
})

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
  catalog.empty = false
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
    // 订阅语义与 slot 运行时合成的 use* 一致（useSyncExternalStore）：store 变更要能
    // 触发重渲染，否则「别处删除分组」这类用例会退化成「组件从未重渲染」的假绿。
    useWatchlists: <T,>(sel: (value: Watchlists) => T): T =>
      sel(useSyncExternalStore(watchlists.subscribe, watchlists.getSnapshot, watchlists.getSnapshot)),
    useWatchlistGroups: <T,>(sel: (value: ReturnType<typeof groups.getSnapshot>) => T): T =>
      sel(useSyncExternalStore(groups.subscribe, groups.getSnapshot, groups.getSnapshot)),
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
  it('渲染分组清单 + 标的表 + 组内 chip；手输命中本地字典 → 采用字典条目', async () => {
    const { added, getAllByText, getByText, getByPlaceholderText, container } = renderManager({
      groups: [{ id: 'g1', name: '核心仓', createdAt: 1 }],
      rows: { us: [{ market: 'us', symbol: 'AAPL', name: '苹果', groups: ['g1'] }] },
    })
    expect(getByText('manager.title')).toBeTruthy()
    // 左栏分组行 + 右栏行上 chip 各一处
    expect(getAllByText('核心仓')).toHaveLength(2)
    expect(getByText('AAPL')).toBeTruthy()
    expect(getByText('苹果')).toBeTruthy()

    // 字典命中路径：PLTR / 00700.HK 都在本地字典里，直接采用条目（不经过形态推断；
    // 推断路径由下一例单独覆盖）。
    const input = getByPlaceholderText('manager.addPlaceholder')
    fireEvent.change(input, { target: { value: 'PLTR' } })
    await act(async () => { fireEvent.submit(container.querySelector('form.paneAdd') ?? input) })
    await waitFor(() => { expect(added).toEqual([{ market: 'us', symbol: 'PLTR' }]) })

    // 港股数字形态 → hk 规范形
    fireEvent.change(input, { target: { value: '700' } })
    await act(async () => { fireEvent.submit(container.querySelector('form.paneAdd') ?? input) })
    await waitFor(() => { expect(added).toEqual([{ market: 'us', symbol: 'PLTR' }, { market: 'hk', symbol: '00700.HK' }]) })
  })

  it('本地字典无命中 → 按代码形态推断市场并归一（修正前恒落 crypto）', async () => {
    // 强制字典恒空：PLTR/700 在真实字典里都有条目，只会走字典命中分支，
    // 形态推断（inferInputMarket）永远执行不到——本用例单独把字典清空。
    catalog.empty = true
    const { added, getByPlaceholderText, container } = renderManager({
      rows: { us: [{ market: 'us', symbol: 'AAPL', name: '苹果' }] },
    })
    const input = getByPlaceholderText('manager.addPlaceholder')
    const submit = async (value: string): Promise<void> => {
      fireEvent.change(input, { target: { value } })
      await act(async () => { fireEvent.submit(container.querySelector('form.paneAdd') ?? input) })
    }

    // 美股 ticker 形态 → us（修正前 FALLBACK_MARKETS[0] 恒落 crypto）
    await submit('PLTR')
    await waitFor(() => { expect(added).toEqual([{ market: 'us', symbol: 'PLTR' }]) })
    // 港股数字形态 → hk 规范形补零
    await submit('700')
    // 6 位 A 股数字 → cn 补交易所后缀
    await submit('600519')
    // 加密计价标记 → crypto（证明推断不是「一律 us」）
    await submit('BTCUSDT')
    await waitFor(() => {
      expect(added).toEqual([
        { market: 'us', symbol: 'PLTR' },
        { market: 'hk', symbol: '00700.HK' },
        { market: 'cn', symbol: '600519.SH' },
        { market: 'crypto', symbol: 'BTCUSDT' },
      ])
    })
  })

  it('活动分组被别处删除 → 范围归位全部（组外行不再被悬挂 id 过滤误藏）', async () => {
    const { getAllByLabelText, getAllByText, getByText, queryByText, groups } = renderManager({
      groups: [{ id: 'g1', name: '核心仓', createdAt: 1 }],
      rows: {
        us: [
          { market: 'us', symbol: 'AAPL', name: '苹果', groups: ['g1'] },
          // 组外行：悬挂 id 过滤下会被误藏，是「归位全部」的唯一可判别证据
          // （t('group.all') 由左栏无条件渲染，仅断言它不构成判别）。
          { market: 'us', symbol: 'TSLA', name: '特斯拉' },
        ],
      },
    })
    // 进入分组范围（点左栏分组行；行上 chip 同名，用 closest('button') 区分）
    const railRow = getAllByText('核心仓').map(el => el.closest('button')).find(btn => btn !== null)
    expect(railRow).toBeTruthy()
    fireEvent.click(railRow as HTMLElement)
    await waitFor(() => { expect(getByText('AAPL')).toBeTruthy() })
    // 过滤确实在生效（组外行被藏、表内仅一行）——后续断言才有意义
    expect(queryByText('TSLA')).toBeNull()
    expect(getAllByLabelText('row.group')).toHaveLength(1)

    // 别处删除该分组（SSE 重拉/另一标签页）→ 范围归位「全部」：两行都在，全部行高亮
    act(() => { groups.removeGroupLocal('g1') })
    await waitFor(() => { expect(getByText('TSLA')).toBeTruthy() })
    expect(getByText('AAPL')).toBeTruthy()
    // 表内行数从 1（仅 g1 成员）涨到多行——悬挂 id 过滤回退后组外行回归
    expect(getAllByLabelText('row.group').length).toBeGreaterThan(1)
    const allRailRow = getAllByText('group.all').map(el => el.closest('button')).find(btn => btn !== null)
    expect(allRailRow?.getAttribute('data-active')).toBe('true')
  })
})
