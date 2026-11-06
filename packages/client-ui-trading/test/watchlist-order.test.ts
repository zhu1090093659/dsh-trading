/**
 * 自选列表排序与置顶分区单测（2026-11-05 用户裁决，纯函数）：`orderWatchlistRows` 是
 * MarketSidebar 渲染与单测共用的同一判据，因此这里钉住四条语义——置顶行整体进顶部分区
 * 且列表区不重复、两个区各自一份排序、缺涨跌幅的行任何方向都排末尾（未知不是「最小
 * 涨幅」）、等值保持存储顺序。另附表头三态循环 `nextSortMode`。
 */
import { describe, expect, it } from 'vitest'
import type { Instrument } from '../src/client/types.ts'
import type { WatchlistSortMode } from '../src/client/store.ts'
import { nextSortMode, orderWatchlistRows } from '../src/client/watchlist-order.ts'

const us = (symbol: string): Instrument => ({ market: 'us', symbol })
const hk = (symbol: string): Instrument => ({ market: 'hk', symbol })
const keyOf = (row: Instrument): string => `${row.market}:${row.symbol}`

interface Spec {
  rows: readonly Instrument[]
  pinned?: readonly string[]
  sortRows?: WatchlistSortMode
  sortPinned?: WatchlistSortMode
  /** row 键（`market:symbol`）→ 涨跌幅；没列出的行 = 涨跌幅未知。 */
  pct?: Record<string, number>
}

/** 只把两区的 symbol 序列取出来断言（具体值，不用「包含」糊过去）。 */
function orderSymbols(spec: Spec): { pinned: string[]; rest: string[] } {
  const result = orderWatchlistRows({
    rows: spec.rows,
    pinned: spec.pinned ?? [],
    sort: { rows: spec.sortRows ?? 'default', pinned: spec.sortPinned ?? 'default' },
    pctOf: row => spec.pct?.[keyOf(row)],
    keyOf,
  })
  return { pinned: result.pinned.map(row => row.symbol), rest: result.rest.map(row => row.symbol) }
}

describe('orderWatchlistRows · 置顶分区', () => {
  it('用户把某行置顶后，该行进置顶区并从列表区消失（两区不重复）', () => {
    // Given 三行美股，其中苹果被置顶
    const rows = [us('AAPL'), us('MSFT'), us('NVDA')]
    const pct: Record<string, number> = { 'us:AAPL': 1.5, 'us:MSFT': -0.5, 'us:NVDA': 0.2 }
    // When 按默认排序切分两区（取完整行对象，不只看 symbol）
    const result = orderWatchlistRows({
      rows,
      pinned: ['us:AAPL'],
      sort: { rows: 'default', pinned: 'default' },
      pctOf: row => pct[keyOf(row)],
      keyOf,
    })
    // Then 置顶区就是那一行，列表区逐行不含它
    expect(result.pinned).toEqual([{ market: 'us', symbol: 'AAPL' }])
    expect(result.rest).toEqual([{ market: 'us', symbol: 'MSFT' }, { market: 'us', symbol: 'NVDA' }])
  })

  it('用户给两个区设了不同方向时，置顶区与列表区各自按自己的方向排序', () => {
    // Given 五行美股涨跌幅（苹果 3、微软 1、英伟达 2、谷歌 -4、特斯拉 0.5），其中苹果与谷歌被置顶
    const rows = [us('AAPL'), us('MSFT'), us('NVDA'), us('GOOGL'), us('TSLA')]
    const pct: Record<string, number> = { 'us:AAPL': 3, 'us:MSFT': 1, 'us:NVDA': 2, 'us:GOOGL': -4, 'us:TSLA': 0.5 }
    const pinned = ['us:AAPL', 'us:GOOGL']
    // When 列表区降序、置顶区升序；再把两区方向对调
    const mixed = orderSymbols({ rows, pinned, sortRows: 'pct-desc', sortPinned: 'pct-asc', pct })
    const swapped = orderSymbols({ rows, pinned, sortRows: 'pct-asc', sortPinned: 'pct-desc', pct })
    // Then 两区互不影响：列表区降序 [NVDA 2, MSFT 1, TSLA 0.5]、置顶区升序 [GOOGL -4, AAPL 3]
    expect(mixed).toEqual({ pinned: ['GOOGL', 'AAPL'], rest: ['NVDA', 'MSFT', 'TSLA'] })
    // And 方向对调后各自反向，仍是两区独立
    expect(swapped).toEqual({ pinned: ['AAPL', 'GOOGL'], rest: ['TSLA', 'MSFT', 'NVDA'] })
  })

  it('用户置顶顺序与存储顺序不同时，置顶区仍按存储顺序（置顶键集只决定归属）', () => {
    // Given 存储顺序是苹果在前、英伟达在后，而置顶键集里英伟达在前
    const rows = [us('AAPL'), us('NVDA')]
    // When 默认排序切分
    // Then 置顶区跟存储顺序走，不跟键集顺序走
    expect(orderSymbols({ rows, pinned: ['us:NVDA', 'us:AAPL'] })).toEqual({ pinned: ['AAPL', 'NVDA'], rest: [] })
  })

  it('用户置顶的键在当前视图里没有对应行时，不产生幽灵行', () => {
    // Given 当前视图只有美股两行，置顶键集里还有别的页签的行（港股腾讯、美股特斯拉）
    const rows = [us('AAPL'), us('MSFT')]
    const pct: Record<string, number> = { 'us:AAPL': 1, 'us:MSFT': 2 }
    // When 切分两区
    const result = orderSymbols({ rows, pinned: ['hk:00700', 'us:TSLA'], sortRows: 'pct-desc', pct })
    // Then 置顶区为空（不为缺席的键造行），列表区两行俱在
    expect(result).toEqual({ pinned: [], rest: ['MSFT', 'AAPL'] })
  })

  it('用户的视图为空时，两区都返回空数组（空 rows 与空 pinned 两种边界）', () => {
    // Given 一组空候选行、一组非空候选行
    const pct: Record<string, number> = { 'us:AAPL': 1 }
    // When 分别用「空 rows + 有置顶键」与「有 rows + 空置顶键」切分
    const emptyRows = orderSymbols({ rows: [], pinned: ['us:AAPL'], sortRows: 'pct-desc', pct })
    const emptyPinned = orderSymbols({ rows: [us('AAPL')], pinned: [], sortRows: 'pct-desc', pct })
    // Then 两者都是空置顶区；后者列表区保留那一行
    expect(emptyRows).toEqual({ pinned: [], rest: [] })
    expect(emptyPinned).toEqual({ pinned: [], rest: ['AAPL'] })
  })

  it('用户保留默认排序时，两区都保持存储顺序（不按涨跌幅排）', () => {
    // Given 存储顺序与涨跌幅相反的行，其中两行被置顶
    const rows = [us('AAPL'), us('MSFT'), us('NVDA'), hk('00700')]
    const pct: Record<string, number> = { 'us:AAPL': -1, 'us:MSFT': 5, 'us:NVDA': 0.1, 'hk:00700': 8 }
    // When 两区都用 default
    const result = orderSymbols({ rows, pinned: ['us:MSFT', 'hk:00700'], pct })
    // Then 置顶区 [MSFT, 00700]、列表区 [AAPL, NVDA]，都是存储顺序
    expect(result).toEqual({ pinned: ['MSFT', '00700'], rest: ['AAPL', 'NVDA'] })
  })
})

describe('orderWatchlistRows · 涨跌幅三态', () => {
  it('用户按涨跌幅降序看列表时，行从高到低排列', () => {
    // Given 五行涨跌幅（含负值与接近零的小数）
    const rows = [us('AAPL'), us('MSFT'), us('NVDA'), us('GOOGL'), us('TSLA')]
    const pct: Record<string, number> = { 'us:AAPL': 2.5, 'us:MSFT': -1.2, 'us:NVDA': 0.4, 'us:GOOGL': 9.9, 'us:TSLA': -0.1 }
    // When 按降序排
    const result = orderSymbols({ rows, sortRows: 'pct-desc', pct })
    // Then 全序从高到低
    expect(result.rest).toEqual(['GOOGL', 'AAPL', 'NVDA', 'TSLA', 'MSFT'])
  })

  it('用户按涨跌幅升序看列表时，行从低到高排列', () => {
    // Given 同一组五行涨跌幅
    const rows = [us('AAPL'), us('MSFT'), us('NVDA'), us('GOOGL'), us('TSLA')]
    const pct: Record<string, number> = { 'us:AAPL': 2.5, 'us:MSFT': -1.2, 'us:NVDA': 0.4, 'us:GOOGL': 9.9, 'us:TSLA': -0.1 }
    // When 按升序排
    const result = orderSymbols({ rows, sortRows: 'pct-asc', pct })
    // Then 全序从低到高
    expect(result.rest).toEqual(['MSFT', 'TSLA', 'NVDA', 'AAPL', 'GOOGL'])
  })

  it('用户切换排序方向时，没有涨跌幅的行在两个方向都排末尾', () => {
    // Given 三行有涨跌幅、两行涨跌幅未知（报价还没落地）
    const rows = [us('AAPL'), us('MSFT'), us('NVDA'), us('GOOGL'), us('TSLA')]
    const pct: Record<string, number> = { 'us:AAPL': 2, 'us:MSFT': -3, 'us:NVDA': 1 }
    // When 分别按降序与升序排
    const desc = orderSymbols({ rows, sortRows: 'pct-desc', pct })
    const asc = orderSymbols({ rows, sortRows: 'pct-asc', pct })
    // Then 两个方向都把它们压在末尾，且两行之间保持存储顺序（GOOGL 在 TSLA 之前）
    expect(desc.rest).toEqual(['AAPL', 'NVDA', 'MSFT', 'GOOGL', 'TSLA'])
    expect(asc.rest).toEqual(['MSFT', 'NVDA', 'AAPL', 'GOOGL', 'TSLA'])
  })

  it('用户按涨跌幅排序时，涨跌幅相同的行保持存储顺序（稳定性）', () => {
    // Given 三行涨跌幅相同、一行更高
    const rows = [us('AAPL'), us('MSFT'), us('NVDA'), us('GOOGL')]
    const pct: Record<string, number> = { 'us:AAPL': 1, 'us:MSFT': 1, 'us:NVDA': 1, 'us:GOOGL': 2 }
    // When 分别按降序与升序排
    const desc = orderSymbols({ rows, sortRows: 'pct-desc', pct })
    const asc = orderSymbols({ rows, sortRows: 'pct-asc', pct })
    // Then 等值三行在两个方向都保持存储顺序（不依赖引擎 sort 的稳定性）
    expect(desc.rest).toEqual(['GOOGL', 'AAPL', 'MSFT', 'NVDA'])
    expect(asc.rest).toEqual(['AAPL', 'MSFT', 'NVDA', 'GOOGL'])
  })

  it('用户按涨跌幅排完序后，原始候选行数组的顺序不被就地改动', () => {
    // Given 一份候选行与它的顺序快照
    const rows = [us('AAPL'), us('MSFT'), us('NVDA')]
    const pct: Record<string, number> = { 'us:AAPL': 1, 'us:MSFT': 3, 'us:NVDA': 2 }
    const before = rows.map(row => row.symbol)
    // When 按降序排
    orderSymbols({ rows, sortRows: 'pct-desc', pct })
    // Then 入参顺序原样（排序在副本上做）
    expect(rows.map(row => row.symbol)).toEqual(before)
  })
})

describe('nextSortMode（表头三态循环）', () => {
  it('用户点表头时，排序模式按 default → pct-desc → pct-asc → default 循环', () => {
    // Given 起始模式是默认排序
    let mode: WatchlistSortMode = 'default'
    // When 连点四次表头
    const steps: WatchlistSortMode[] = []
    for (let i = 0; i < 4; i += 1) {
      mode = nextSortMode(mode)
      steps.push(mode)
    }
    // Then 三步一循环，第四步回到起点
    expect(steps).toEqual(['pct-desc', 'pct-asc', 'default', 'pct-desc'])
  })

  it('用户从任意一态继续点表头时，下一个态唯一确定（无分支歧义）', () => {
    // Given 三个可用模式
    const modes: WatchlistSortMode[] = ['default', 'pct-desc', 'pct-asc']
    // When 各自推进一步
    // Then 映射固定：default→pct-desc、pct-desc→pct-asc、pct-asc→default
    expect(modes.map(entry => nextSortMode(entry))).toEqual(['pct-desc', 'pct-asc', 'default'])
  })
})
