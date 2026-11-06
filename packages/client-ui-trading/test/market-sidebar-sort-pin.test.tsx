/**
 * MarketSidebar 置顶分区 + 涨跌幅三态排序（2026-11-05，富途牛牛式交互）。
 *
 * 覆盖：置顶行整体进顶部分区且列表区不再重复出现、两区各自的三态排序互不影响、
 * 行内置顶开关真的走注入的写路径且不触发选中、键盘置顶后焦点跟回同一行的开关
 * （鼠标点击不抢焦点）、无置顶（或单区为空）时不渲染置顶标题与分隔线；行内 ✕ 在
 * 分组视图只移出分组、在普通视图移出自选，行内分组按钮把归属弹层 portal 到 body 上
 * 开合（行是 <button>，弹层自带 <button>，内联即非法嵌套），点外与 Escape 都能收起来。
 *
 * 零 mock：组件照常直连真实 api 模块，只在全局 fetch 上挂一个契约替身——同一组
 * /dshtrading/api 路径与 wire 形状（markets 名册 + tickers 业务信封），于是 api.ts
 * 的取数、业务错误信封与 MarketSidebar 的轮询接线都是真跑的；store 全部是
 * createWatchlist* 真实例，注入的两条写路径与 index.ts 的实现逐字同构。
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarketSidebar } from '../src/client/MarketSidebar.tsx'
import { createWatchlistGroupsStore, createWatchlistSortStore, createWatchlistStore } from '../src/client/store.ts'
import type { Observable, SelectionState, WatchlistSortPrefs, Watchlists } from '../src/client/store.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { Instrument, MarketId, WatchlistGroupMeta } from '../src/client/types.ts'

/** key 直出翻译：断言拿 key 而不是文案，与词典解耦。 */
const t = (key: MarketLocaleKey): string => key

/** 一根报价（昨收恒 100，价格直接决定涨跌幅：95 → -5.00%）。 */
interface Quote {
  price: number
  prevClose: number
  name?: string
}

/** 桥面替身账本（真实 fetch 契约，不是 mock 工具）。 */
const bridge = {
  markets: [] as MarketId[],
  /** `market:symbol` → 报价。 */
  quotes: new Map<string, Quote>(),
}

/** 一个报价行的入参：价格 + 名称，昨收恒 100；`groups` 是它的分组归属（issue #82）。 */
interface RowSpec {
  symbol: string
  price: number
  name: string
  groups?: string[]
}

/** 分组注册表夹具：弹层要能同时看到「已归属」与「未归属」两种勾选态。 */
const GROUP_TECH: WatchlistGroupMeta = { id: 'g1', name: '科技', createdAt: 1_760_000_000_000 }
const GROUP_DIVIDEND: WatchlistGroupMeta = { id: 'g2', name: '红利', createdAt: 1_760_000_100_000 }

const PREV_CLOSE = 100

/** 契约替身：按桥的真实路径与 wire 形状回包（业务错误也是桥的形状）。 */
function serve(url: string): { status: number; body: unknown } {
  const path = url.split('?')[0] ?? url
  const params = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
  if (path === '/dshtrading/api/markets') {
    return { status: 200, body: { markets: bridge.markets.map(id => ({ id })) } }
  }
  if (path === '/dshtrading/api/tickers') {
    const market = params.get('market') ?? ''
    const symbols = (params.get('symbols') ?? '').split(',').filter(symbol => symbol !== '')
    const tickers: Record<string, unknown> = {}
    for (const symbol of symbols) {
      const quote = bridge.quotes.get(`${market}:${symbol}`)
      tickers[symbol] = quote === undefined
        ? { ok: false, code: 'TRADING_SYMBOL_NOT_FOUND', message: `no quote: ${symbol}` }
        : {
            ok: true,
            ticker: {
              symbol,
              price: quote.price,
              prevClose: quote.prevClose,
              timestamp: 1_760_000_000_000,
              ...(quote.name === undefined ? {} : { name: quote.name }),
            },
          }
    }
    return { status: 200, body: { tickers } }
  }
  if (path === '/dshtrading/api/symbols') return { status: 200, body: { symbols: [] } }
  if (path === '/dshtrading/api/klines') return { status: 200, body: { klines: [] } }
  return { status: 404, body: { code: 'TRADING_NOT_FOUND', message: path } }
}

/** 最小 Response 面（api.getJson 只读 status/ok/json）。 */
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response
}

const realFetch = globalThis.fetch

beforeEach(() => {
  bridge.markets = []
  bridge.quotes = new Map()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const { status, body } = serve(url)
    return jsonResponse(status, body)
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

/** 真 Observable → 选择器 hook，等价于 slot 运行时从 hooks 合成出来的 use* prop。 */
function selectorOf<T>(store: Observable<T>): <S>(select: (value: T) => S) => S {
  return <S,>(select: (value: T) => S): S => select(useSyncExternalStore(store.subscribe, store.getSnapshot))
}

interface Harness {
  container: HTMLElement
  groups: ReturnType<typeof createWatchlistGroupsStore>
  sort: ReturnType<typeof createWatchlistSortStore>
  /** 选中回调的调用记录（置顶开关不得写进来）。 */
  selectCalls: Instrument[]
  /** 注入的置顶写路径调用记录。 */
  pinCalls: Array<{ key: string; pinned: boolean }>
  /** 注入的排序循环调用记录。 */
  cycleCalls: Array<'rows' | 'pinned'>
  /** 注入的「移出自选」写路径调用记录（普通视图的 ✕）。 */
  removeCalls: Array<{ market: MarketId; symbol: string }>
  /** 注入的分组成员写路径调用记录（分组视图的 ✕ 与弹层勾选）。 */
  memberCalls: Array<{ id: string; market: string; symbol: string; member: boolean; name?: string }>
}

/**
 * 挂载侧栏：自选行来自真实 watchlist store，分组注册表/置顶来自真实 groups store，
 * 排序偏好来自真实 sort store；注入的四条写路径与 index.ts 的实现同构（只多一层
 * 调用记录，用于断言「到底走了哪条写路径」）。
 */
function mountSidebar(rows: RowSpec[], pinned: string[] = [], registry: WatchlistGroupMeta[] = []): Harness {
  bridge.markets = ['us']
  for (const row of rows) {
    bridge.quotes.set(`us:${row.symbol}`, { price: row.price, prevClose: PREV_CLOSE, name: row.name })
  }
  // 三个 store 都会水合 localStorage，可能带着上一条用例的残留：一律覆盖成本用例的
  // 唯一真相（自选行及其归属 / 分组注册表与置顶键集 / 两区排序），用例之间互不影响。
  const watchlists = createWatchlistStore()
  watchlists.applyHost({
    us: rows.map(row => ({
      market: 'us' as const,
      symbol: row.symbol,
      name: row.name,
      ...(row.groups === undefined ? {} : { groups: row.groups }),
    })),
  })
  const groups = createWatchlistGroupsStore()
  groups.applyHost(registry, pinned)
  // 活动分组同属本地 UI 态：显式归位到「全部」，分组视图只能由用例自己切进去。
  groups.setActiveGroup(null)
  const sort = createWatchlistSortStore()
  sort.set({ rows: 'default', pinned: 'default' })
  const selection: SelectionState = { instrument: null }
  const selectCalls: Instrument[] = []
  const pinCalls: Array<{ key: string; pinned: boolean }> = []
  const cycleCalls: Array<'rows' | 'pinned'> = []
  const removeCalls: Array<{ market: MarketId; symbol: string }> = []
  const memberCalls: Array<{ id: string; market: string; symbol: string; member: boolean; name?: string }> = []

  const view = render(
    <MarketSidebar
      t={t}
      useSelection={<T,>(select: (value: SelectionState) => T): T => select(selection)}
      useWatchlists={selectorOf<Watchlists>(watchlists)}
      useGroups={selectorOf(groups)}
      useSortPrefs={selectorOf<WatchlistSortPrefs>(sort)}
      addInstrument={() => {}}
      removeInstrument={(market, symbol) => { removeCalls.push({ market, symbol }) }}
      selectInstrument={(instrument) => { selectCalls.push(instrument) }}
      openSettings={() => {}}
      createGroup={async () => ({ ok: false as const, reason: 'unavailable' as const })}
      renameGroup={async () => ({ ok: false as const, reason: 'unavailable' as const })}
      deleteGroup={async () => false}
      assignGroupMember={async (id, market, symbol, member, name) => {
        memberCalls.push({ id, market, symbol, member, ...(name === undefined ? {} : { name }) })
        return true
      }}
      setActiveGroup={(id) => { groups.setActiveGroup(id) }}
      setPinned={async (key, next) => {
        pinCalls.push({ key, pinned: next })
        return groups.setPinned(key, next)
      }}
      cycleSort={(zone) => {
        cycleCalls.push(zone)
        return sort.cycle(zone)
      }}
    />,
  )
  return { container: view.container, groups, sort, selectCalls, pinCalls, cycleCalls, removeCalls, memberCalls }
}

/** 某区当前渲染的 data-row-key 顺序（all = 文档顺序，pinned / rest 各自成区）。 */
function rowKeys(container: HTMLElement, zone: 'all' | 'pinned' | 'rest' = 'all'): string[] {
  const selector = zone === 'pinned'
    ? '[data-row-key][data-pinned="true"]'
    : zone === 'rest' ? '[data-row-key]:not([data-pinned])' : '[data-row-key]'
  return Array.from(container.querySelectorAll<HTMLElement>(selector))
    .map(node => node.getAttribute('data-row-key') ?? '')
}

/** 某区的表头排序按钮。 */
function sortButton(container: HTMLElement, zone: 'rows' | 'pinned'): HTMLElement {
  const button = container.querySelector<HTMLElement>(`[data-sort-zone="${zone}"]`)
  if (button === null) throw new Error(`missing sort button: ${zone}`)
  return button
}

/** 某行的行内置顶开关（span[role=button]，行是 <button> 不能嵌套 <button>）。 */
function pinToggle(container: HTMLElement, key: string): HTMLElement {
  const toggle = container.querySelector<HTMLElement>(`[data-row-key="${key}"] [data-pin-toggle="true"]`)
  if (toggle === null) throw new Error(`missing pin toggle: ${key}`)
  return toggle
}

/**
 * 某行的行内动作按钮（✕ / 分组）：`label` 是直出翻译 key——row.remove 移出自选、
 * group.remove 移出分组、row.group 打开归属弹层。
 */
function rowAction(container: HTMLElement, key: string, label: string): HTMLElement {
  const action = Array.from(container.querySelectorAll<HTMLElement>(`[data-row-key="${key}"] span[role="button"]`))
    .find(node => node.getAttribute('aria-label') === label)
  if (action === undefined) throw new Error(`missing row action: ${key} ${label}`)
  return action
}

/**
 * 标题区「自选 ▾」分组下拉开关（分组视图的入口）。行内分组触发器现在也带
 * aria-haspopup，但它是 `span[role="button"]`——这个 helper 只认真 `<button>`。
 */
function titleDropdown(container: HTMLElement): HTMLElement {
  const button = container.querySelector<HTMLElement>('button[aria-haspopup="menu"]')
  if (button === null) throw new Error('missing title dropdown')
  return button
}

/** 标题下拉里文案含 `text` 的那一项（分组名 / 全部 / 创建 / 管理）。 */
function menuItem(container: HTMLElement, text: string): HTMLElement {
  const item = Array.from(container.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'))
    .find(node => (node.textContent ?? '').includes(text))
  if (item === undefined) throw new Error(`missing menu item: ${text}`)
  return item
}

/** 文档顺序判定：a 是否排在 b 之前。 */
function isBefore(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/** 每行报价单元格里的涨跌幅文本（文档顺序）：报价落地后才非空，也用来等行情。 */
function pctTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-row-key]')).map((node) => {
    const texts = Array.from(node.querySelectorAll('span')).map(span => span.textContent ?? '')
    return texts.filter(text => /^[+-]?\d+\.\d{2}%$/.test(text))[0] ?? ''
  })
}

/** 五行夹具：存储顺序与涨跌幅顺序刻意错开（-5 / -10 / +10 / +5 / +8）。 */
const FIVE_ROWS: RowSpec[] = [
  { symbol: 'TSLA', price: 95, name: '特斯拉' },
  { symbol: 'MSFT', price: 90, name: '微软' },
  { symbol: 'AAPL', price: 110, name: '苹果' },
  { symbol: 'NVDA', price: 105, name: '英伟达' },
  { symbol: 'AMZN', price: 108, name: '亚马逊' },
]

describe('MarketSidebar 置顶分区与涨跌幅排序', () => {
  it('用户应该在置顶一条标的时，让它进入置顶分区并移出列表区', async () => {
    // Given: 三行自选、默认顺序、没有任何置顶
    const harness = mountSidebar([
      { symbol: 'TSLA', price: 95, name: '特斯拉' },
      { symbol: 'AAPL', price: 110, name: '苹果' },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ])
    await waitFor(() => { expect(pctTexts(harness.container)).toEqual(['-5.00%', '+10.00%', '-10.00%']) })
    expect(rowKeys(harness.container)).toEqual(['us:TSLA', 'us:AAPL', 'us:MSFT'])
    expect(harness.container.querySelector('[data-pinned-header]')).toBeNull()

    // When: 点第二行（苹果）的置顶开关
    fireEvent.click(pinToggle(harness.container, 'us:AAPL'))

    // Then: 苹果进置顶分区（标题行之后、带 data-pinned），列表区不再有它
    await waitFor(() => { expect(rowKeys(harness.container, 'pinned')).toEqual(['us:AAPL']) })
    const header = harness.container.querySelector<HTMLElement>('[data-pinned-header]')
    expect(header).not.toBeNull()
    expect(header?.textContent).toContain('pinned.title')
    expect(header?.querySelector('[data-sort-zone="pinned"]')).not.toBeNull()
    const pinnedRow = harness.container.querySelector<HTMLElement>('[data-row-key="us:AAPL"]')
    expect(pinnedRow?.getAttribute('data-pinned')).toBe('true')
    expect(isBefore(header as HTMLElement, pinnedRow as HTMLElement)).toBe(true)
    expect(rowKeys(harness.container, 'rest')).toEqual(['us:TSLA', 'us:MSFT'])
    // 且两组之间的分隔线正好落在置顶行与列表区首行之间
    const divider = harness.container.querySelector<HTMLElement>('[data-pinned-divider="true"]')
    expect(divider).not.toBeNull()
    expect(isBefore(pinnedRow as HTMLElement, divider as HTMLElement)).toBe(true)
    expect(isBefore(divider as HTMLElement, harness.container.querySelector('[data-row-key="us:TSLA"]') as HTMLElement)).toBe(true)
  })

  it('用户应该在循环点击列表表头时，依次切到涨幅从高到低、从低到高再回到默认顺序', async () => {
    // Given: 三行自选与已经落地的涨跌幅（-5% / +10% / -10%），列表区默认按存储顺序
    const harness = mountSidebar([
      { symbol: 'TSLA', price: 95, name: '特斯拉' },
      { symbol: 'AAPL', price: 110, name: '苹果' },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ])
    await waitFor(() => { expect(pctTexts(harness.container)).toEqual(['-5.00%', '+10.00%', '-10.00%']) })
    const button = () => sortButton(harness.container, 'rows')
    expect(button().getAttribute('data-sort-mode')).toBe('default')
    expect(button().getAttribute('aria-label')).toBe('sort.default')
    expect(button().querySelector('svg')).toBeNull()

    // When: 第一次点击
    fireEvent.click(button())
    // Then: 涨幅从高到低（+10 / -5 / -10），模式与读屏文案同步，方向箭头出现
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL', 'us:TSLA', 'us:MSFT']) })
    expect(button().getAttribute('data-sort-mode')).toBe('pct-desc')
    expect(button().getAttribute('aria-label')).toBe('sort.pctDesc')
    expect(button().getAttribute('title')).toBe('sort.pctDesc')
    expect(button().querySelector('svg')).not.toBeNull()

    // When: 第二次点击
    fireEvent.click(button())
    // Then: 涨幅从低到高（-10 / -5 / +10）
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:MSFT', 'us:TSLA', 'us:AAPL']) })
    expect(button().getAttribute('data-sort-mode')).toBe('pct-asc')
    expect(button().getAttribute('aria-label')).toBe('sort.pctAsc')

    // When: 第三次点击
    fireEvent.click(button())
    // Then: 回到默认（存储）顺序，箭头收起
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:TSLA', 'us:AAPL', 'us:MSFT']) })
    expect(button().getAttribute('data-sort-mode')).toBe('default')
    expect(button().querySelector('svg')).toBeNull()
  })

  it('用户应该只在所点的那个排序区生效，置顶区与列表区排序彼此独立', async () => {
    // Given: 三行置顶（存储顺序 -5 / -10 / +10）+ 两行列表（+5 / +8），两区都还是默认顺序
    const harness = mountSidebar(FIVE_ROWS, ['us:TSLA', 'us:MSFT', 'us:AAPL'])
    await waitFor(() => { expect(pctTexts(harness.container).filter(text => text !== '')).toHaveLength(5) })
    expect(rowKeys(harness.container, 'pinned')).toEqual(['us:TSLA', 'us:MSFT', 'us:AAPL'])
    expect(rowKeys(harness.container, 'rest')).toEqual(['us:NVDA', 'us:AMZN'])

    // When: 只点列表区表头一次（切到涨幅从高到低）
    fireEvent.click(sortButton(harness.container, 'rows'))

    // Then: 列表区按涨跌幅重排（+8 在 +5 前面），置顶区保持默认顺序
    await waitFor(() => { expect(rowKeys(harness.container, 'rest')).toEqual(['us:AMZN', 'us:NVDA']) })
    expect(rowKeys(harness.container, 'pinned')).toEqual(['us:TSLA', 'us:MSFT', 'us:AAPL'])
    expect(sortButton(harness.container, 'pinned').getAttribute('data-sort-mode')).toBe('default')

    // When: 只点置顶区排序按钮两次（默认 → 涨幅降序 → 涨幅升序）
    fireEvent.click(sortButton(harness.container, 'pinned'))
    fireEvent.click(sortButton(harness.container, 'pinned'))

    // Then: 置顶区按升序重排（-10 / -5 / +10），列表区仍是它自己的降序结果
    await waitFor(() => { expect(rowKeys(harness.container, 'pinned')).toEqual(['us:MSFT', 'us:TSLA', 'us:AAPL']) })
    expect(rowKeys(harness.container, 'rest')).toEqual(['us:AMZN', 'us:NVDA'])
    expect(sortButton(harness.container, 'rows').getAttribute('data-sort-mode')).toBe('pct-desc')
    expect(sortButton(harness.container, 'pinned').getAttribute('data-sort-mode')).toBe('pct-asc')
    expect(harness.cycleCalls).toEqual(['rows', 'pinned', 'pinned'])
  })

  it('用户应该点行内置顶开关时调用注入的 setPinned，且不触发该行的选中回调', async () => {
    // Given: 两行自选、没有置顶
    const harness = mountSidebar([
      { symbol: 'AAPL', price: 110, name: '苹果' },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ])
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL', 'us:MSFT']) })
    const toggle = pinToggle(harness.container, 'us:AAPL')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('row.pin')
    expect(toggle.getAttribute('title')).toBe('row.pin')

    // When: 点苹果行的置顶开关
    fireEvent.click(toggle)

    // Then: 注入的写路径收到 (key, true)，行的选中回调一次都没被调用
    await waitFor(() => { expect(harness.pinCalls).toEqual([{ key: 'us:AAPL', pinned: true }]) })
    expect(harness.selectCalls).toEqual([])
    expect(harness.groups.getSnapshot().pinned).toEqual(['us:AAPL'])
    // 且开关自身翻成「已置顶」：aria-pressed 与文案同步
    await waitFor(() => { expect(pinToggle(harness.container, 'us:AAPL').getAttribute('aria-pressed')).toBe('true') })
    expect(pinToggle(harness.container, 'us:AAPL').getAttribute('aria-label')).toBe('row.unpin')

    // When: 再点一次取消置顶
    fireEvent.click(pinToggle(harness.container, 'us:AAPL'))

    // Then: 写路径收到 (key, false)，行回到列表区
    await waitFor(() => { expect(harness.pinCalls).toEqual([{ key: 'us:AAPL', pinned: true }, { key: 'us:AAPL', pinned: false }]) })
    await waitFor(() => { expect(rowKeys(harness.container, 'rest')).toEqual(['us:AAPL', 'us:MSFT']) })
    expect(harness.container.querySelector('[data-pinned-header]')).toBeNull()
    expect(harness.selectCalls).toEqual([])
  })

  it('用户应该在切到市场页签后，仍按同一套三态排序重排列表', async () => {
    // Given: 三行美股自选，页签停在「自选」，列表是默认（存储）顺序
    const harness = mountSidebar([
      { symbol: 'TSLA', price: 95, name: '特斯拉' },
      { symbol: 'AAPL', price: 110, name: '苹果' },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ])
    await waitFor(() => { expect(pctTexts(harness.container)).toEqual(['-5.00%', '+10.00%', '-10.00%']) })

    // When: 切到美股市场页签，再点一次列表区排序按钮
    const usTab = Array.from(harness.container.querySelectorAll<HTMLElement>('[role="tab"]'))
      .find(tab => tab.textContent === 'tab.us')
    fireEvent.click(usTab as HTMLElement)
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:TSLA', 'us:AAPL', 'us:MSFT']) })
    fireEvent.click(sortButton(harness.container, 'rows'))

    // Then: 市场页签下同样按涨幅从高到低重排（排序与视图无关）
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL', 'us:TSLA', 'us:MSFT']) })
    expect(sortButton(harness.container, 'rows').getAttribute('data-sort-mode')).toBe('pct-desc')
    expect(harness.cycleCalls).toEqual(['rows'])
  })

  it('用户应该在没有置顶标的时，看不到置顶标题行与分隔线', async () => {
    // Given: 三行自选、置顶键集为空
    const harness = mountSidebar(FIVE_ROWS)
    await waitFor(() => { expect(rowKeys(harness.container)).toHaveLength(5) })

    // When: 列表渲染完成（未做任何置顶操作）
    // Then: 没有置顶标题、没有分隔线，全部行都在列表区、都不带 data-pinned
    expect(harness.container.querySelector('[data-pinned-header]')).toBeNull()
    expect(harness.container.querySelector('[data-pinned-divider="true"]')).toBeNull()
    expect(rowKeys(harness.container, 'pinned')).toEqual([])
    expect(rowKeys(harness.container, 'rest')).toHaveLength(5)
  })

  it('用户应该在列表区为空（全部置顶）时，只看到置顶分区而没有分隔线', async () => {
    // Given: 两行自选且两行都已置顶（列表区将是空的）
    const harness = mountSidebar([
      { symbol: 'AAPL', price: 110, name: '苹果' },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ], ['us:AAPL', 'us:MSFT'])

    // When: 侧栏渲染完成
    await waitFor(() => { expect(rowKeys(harness.container, 'pinned')).toEqual(['us:AAPL', 'us:MSFT']) })

    // Then: 置顶标题在、分隔线不在（两组都非空才画线），列表区没有任何行
    expect(harness.container.querySelector('[data-pinned-header]')).not.toBeNull()
    expect(harness.container.querySelector('[data-pinned-divider="true"]')).toBeNull()
    expect(rowKeys(harness.container, 'rest')).toEqual([])
  })

  it('用户应该用键盘置顶一行后，焦点仍停在同一行的置顶开关上', async () => {
    // Given: 两行自选，焦点在苹果行的置顶开关上
    const harness = mountSidebar([
      { symbol: 'AAPL', price: 110, name: '苹果' },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ])
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL', 'us:MSFT']) })
    const toggle = pinToggle(harness.container, 'us:AAPL')
    toggle.focus()
    expect(document.activeElement).toBe(toggle)

    // When: 按 Enter 置顶（该行随之从列表区搬进置顶区，DOM 按位置重建）
    fireEvent.keyDown(toggle, { key: 'Enter' })

    // Then: 写路径收到 (key, true)，行进了置顶区，焦点落在同一行重建后的开关上而不是 body
    await waitFor(() => { expect(rowKeys(harness.container, 'pinned')).toEqual(['us:AAPL']) })
    expect(harness.pinCalls).toEqual([{ key: 'us:AAPL', pinned: true }])
    expect(pinToggle(harness.container, 'us:AAPL').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => { expect(document.activeElement).toBe(pinToggle(harness.container, 'us:AAPL')) })

    // When: 再按一次空格取消置顶（该行搬回列表区，同样重建）
    const pinnedToggle = pinToggle(harness.container, 'us:AAPL')
    pinnedToggle.focus()
    fireEvent.keyDown(pinnedToggle, { key: ' ' })

    // Then: 两次写路径都记下，焦点跟着行回到列表区的开关上
    await waitFor(() => { expect(rowKeys(harness.container, 'rest')).toEqual(['us:AAPL', 'us:MSFT']) })
    expect(harness.pinCalls).toEqual([
      { key: 'us:AAPL', pinned: true },
      { key: 'us:AAPL', pinned: false },
    ])
    await waitFor(() => { expect(document.activeElement).toBe(pinToggle(harness.container, 'us:AAPL')) })
  })

  it('用户应该用鼠标点置顶开关时，不把焦点抢到开关上', async () => {
    // Given: 两行自选，页面上还没有任何元素拿到焦点
    const harness = mountSidebar([
      { symbol: 'AAPL', price: 110, name: '苹果' },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ])
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL', 'us:MSFT']) })
    expect(document.activeElement).toBe(document.body)

    // When: 用鼠标点苹果行的置顶开关
    fireEvent.click(pinToggle(harness.container, 'us:AAPL'))

    // Then: 行照样进置顶区，但焦点没被搬到重建后的开关上（只有键盘激活才恢复）
    await waitFor(() => { expect(rowKeys(harness.container, 'pinned')).toEqual(['us:AAPL']) })
    expect(pinToggle(harness.container, 'us:AAPL').getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(document.body)
  })
})

describe('MarketSidebar 行内动作（✕ 与分组归属）', () => {
  it('用户应该在分组视图下点行内 ✕ 时，只把标的移出该分组而保留在自选里', async () => {
    // Given: 一行自选（苹果）归在「科技」里，视图切到了这个分组
    const harness = mountSidebar(
      [{ symbol: 'AAPL', price: 110, name: '苹果', groups: [GROUP_TECH.id] }],
      [],
      [GROUP_TECH],
    )
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL']) })
    fireEvent.click(titleDropdown(harness.container))
    fireEvent.click(menuItem(harness.container, GROUP_TECH.name))
    await waitFor(() => { expect(harness.groups.getSnapshot().activeGroupId).toBe(GROUP_TECH.id) })
    // 分组视图下 ✕ 的语义变了：文案与分支一起切换
    expect(rowAction(harness.container, 'us:AAPL', 'group.remove').getAttribute('title')).toBe('group.remove')

    // When: 点该行的 ✕
    fireEvent.click(rowAction(harness.container, 'us:AAPL', 'group.remove'))

    // Then: 只走分组写路径 member=false（带行名），移出自选的写路径一次都没调，也没选中行
    expect(harness.memberCalls).toEqual([
      { id: GROUP_TECH.id, market: 'us', symbol: 'AAPL', member: false, name: '苹果' },
    ])
    expect(harness.removeCalls).toEqual([])
    expect(harness.selectCalls).toEqual([])
  })

  it('用户应该在普通视图下点行内 ✕ 时，把标的从自选里移除', async () => {
    // Given: 两行自选，注册表里有「科技」但视图停在「全部」（活动分组为空）
    const harness = mountSidebar([
      { symbol: 'AAPL', price: 110, name: '苹果', groups: [GROUP_TECH.id] },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ], [], [GROUP_TECH])
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL', 'us:MSFT']) })
    expect(harness.groups.getSnapshot().activeGroupId).toBeNull()
    expect(rowAction(harness.container, 'us:AAPL', 'row.remove').getAttribute('title')).toBe('row.remove')

    // When: 点苹果行的 ✕
    fireEvent.click(rowAction(harness.container, 'us:AAPL', 'row.remove'))

    // Then: 走移出自选的写路径，分组写路径一次都没调，也没选中行
    expect(harness.removeCalls).toEqual([{ market: 'us', symbol: 'AAPL' }])
    expect(harness.memberCalls).toEqual([])
    expect(harness.selectCalls).toEqual([])
  })

  it('用户应该点行内分组按钮时把归属弹层浮到 body 上，再点一次收起', async () => {
    // Given: 苹果归在「科技」、微软未分组，两个分组都在注册表里，弹层还没打开
    const harness = mountSidebar([
      { symbol: 'AAPL', price: 110, name: '苹果', groups: [GROUP_TECH.id] },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ], [], [GROUP_TECH, GROUP_DIVIDEND])
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL', 'us:MSFT']) })
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    // 未展开：触发器声明弹的是菜单，且展开态是 false
    const trigger = rowAction(harness.container, 'us:AAPL', 'row.group')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    // When: 点苹果行的分组按钮
    fireEvent.click(rowAction(harness.container, 'us:AAPL', 'row.group'))

    // Then: 展开态挂在触发器上（弹层已不在它的 DOM 邻位，读屏只能靠 aria-expanded）
    expect(rowAction(harness.container, 'us:AAPL', 'row.group').getAttribute('aria-expanded')).toBe('true')

    // Then: 弹层 portal 到 document.body——行本身是 <button role="option">，弹层自带
    // <button>（关闭 + 逐组勾选），所以它必须不在任何 <button> 内部（合法 DOM 的结构不变式）
    const popover = document.body.querySelector<HTMLElement>('[role="menu"]')
    if (popover === null) throw new Error('missing row group popover')
    expect(popover.getAttribute('aria-label')).toBe('row.group')
    expect(popover.closest('button')).toBeNull()

    // Then: 原行里不再有菜单（内联渲染已换成 portal），整页仍只有这一个菜单
    expect(harness.container.querySelector('[data-row-key="us:AAPL"] [role="menu"]')).toBeNull()
    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1)

    // Then: 两个分组按已归属/未归属标注，且不触发行选中
    const checkboxes = Array.from(popover.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
      .map(node => ({ name: node.textContent, checked: node.getAttribute('aria-checked') }))
    expect(checkboxes).toEqual([
      { name: GROUP_TECH.name, checked: 'true' },
      { name: GROUP_DIVIDEND.name, checked: 'false' },
    ])
    expect(harness.selectCalls).toEqual([])

    // Then: 按在弹层内部（现在是 body 上的 portal 节点）不算「点外」——外点关闭的
    // ref.contains 判定对 portal 同样成立，弹层不会自己收起来
    const firstGroupItem = popover.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
    if (firstGroupItem === null) throw new Error('missing group checkbox')
    fireEvent.pointerDown(firstGroupItem)
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()

    // When: 再点一次同一个分组按钮
    fireEvent.click(rowAction(harness.container, 'us:AAPL', 'row.group'))

    // Then: 弹层收起，body 里也不再有菜单，触发器的展开态回到 false
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(rowAction(harness.container, 'us:AAPL', 'row.group').getAttribute('aria-expanded')).toBe('false')
  })

  it('用户应该按 Escape 时收起行内分组归属弹层', async () => {
    // Given: 苹果归在「科技」，行内归属弹层已打开（菜单在 body 上，焦点在弹层内）
    const harness = mountSidebar([
      { symbol: 'AAPL', price: 110, name: '苹果', groups: [GROUP_TECH.id] },
    ], [], [GROUP_TECH, GROUP_DIVIDEND])
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL']) })
    fireEvent.click(rowAction(harness.container, 'us:AAPL', 'row.group'))
    const popover = document.body.querySelector<HTMLElement>('[role="menu"]')
    if (popover === null) throw new Error('missing row group popover')
    const checkbox = popover.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
    if (checkbox === null) throw new Error('missing group checkbox')

    // When: 在弹层里的分组项上按 Escape
    fireEvent.keyDown(checkbox, { key: 'Escape' })

    // Then: 弹层收起（键盘出口），页面上不再有菜单，也没有顺手选中行
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(harness.selectCalls).toEqual([])
  })

  it('用户应该点弹层外面时收起行内分组归属弹层', async () => {
    // Given: 苹果行的归属弹层已打开（菜单浮在 body 上，不在行里）
    const harness = mountSidebar([
      { symbol: 'AAPL', price: 110, name: '苹果', groups: [GROUP_TECH.id] },
    ], [], [GROUP_TECH, GROUP_DIVIDEND])
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL']) })
    fireEvent.click(rowAction(harness.container, 'us:AAPL', 'row.group'))
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    const row = harness.container.querySelector<HTMLElement>('[data-row-key="us:AAPL"]')
    if (row === null) throw new Error('missing row: us:AAPL')

    // When: 按在弹层外面的行上（外点判定走的是弹层自己的 ref，与 portal 位置无关）
    fireEvent.pointerDown(row)

    // Then: 弹层收起，body 里不再有菜单
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })

  it('用户应该滚动列表时收起行内分组归属弹层', async () => {
    // Given: 两行自选，苹果行的归属弹层已打开（浮层按点击那一刻的锚点固定定位）
    const harness = mountSidebar([
      { symbol: 'AAPL', price: 110, name: '苹果', groups: [GROUP_TECH.id] },
      { symbol: 'MSFT', price: 90, name: '微软' },
    ], [], [GROUP_TECH, GROUP_DIVIDEND])
    await waitFor(() => { expect(rowKeys(harness.container)).toEqual(['us:AAPL', 'us:MSFT']) })
    fireEvent.click(rowAction(harness.container, 'us:AAPL', 'row.group'))
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    const row = harness.container.querySelector<HTMLElement>('[data-row-key="us:AAPL"]')
    if (row === null) throw new Error('missing row: us:AAPL')

    // When: 列表里发生滚动（scroll 不冒泡，只有捕获阶段的监听收得到）
    fireEvent.scroll(row)

    // Then: 浮层收起——它不会跟着行重定位，与行走脱不如收起来；自选行本身原样还在
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(rowKeys(harness.container)).toEqual(['us:AAPL', 'us:MSFT'])
    expect(rowAction(harness.container, 'us:AAPL', 'row.group').getAttribute('aria-expanded')).toBe('false')
  })
})
