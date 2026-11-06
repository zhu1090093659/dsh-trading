/**
 * 自选列表的排序与置顶分区（纯函数：MarketSidebar 渲染与单测共用同一判据）。
 *
 * 判据（2026-11-05 用户裁决，参考富途牛牛）：
 * - 置顶行整体进顶部分区，列表区不再重复出现；
 * - 两个区各自一份排序（列表区 / 置顶区独立），只按涨跌幅三态；
 * - 缺失涨跌幅（报价还没落地/快照无昨收）的行任何方向都排末尾——未知不是「最小涨幅」；
 * - 等值保持存储顺序（显式 index 兜底，不依赖引擎 sort 的稳定性）。
 */
import type { Instrument } from './types.ts'
import type { WatchlistSortMode } from './store.ts'

export interface WatchlistOrderInput {
  /** 当前视图的候选行（页签/分组过滤后）。 */
  rows: readonly Instrument[]
  /** 置顶键集（`market:symbol`，host 权威）。 */
  pinned: readonly string[]
  sort: { rows: WatchlistSortMode; pinned: WatchlistSortMode }
  /** 行 → 涨跌幅（undefined = 未知）。 */
  pctOf(row: Instrument): number | undefined
  /** 行 → 键（`market:symbol`）。 */
  keyOf(row: Instrument): string
}

export interface WatchlistOrderResult {
  /** 顶部分区（已按 pinned 区排序）。 */
  pinned: Instrument[]
  /** 列表区（已按 rows 区排序，不含置顶行）。 */
  rest: Instrument[]
}

function sortByMode(
  rows: readonly Instrument[],
  mode: WatchlistSortMode,
  pctOf: (row: Instrument) => number | undefined,
): Instrument[] {
  const list = [...rows]
  if (mode === 'default' || list.length < 2) return list
  const ranked = list.map((row, index) => ({ row, index, pct: pctOf(row) }))
  ranked.sort((left, right) => {
    if (left.pct === undefined || right.pct === undefined) {
      if (left.pct === undefined && right.pct === undefined) return left.index - right.index
      return left.pct === undefined ? 1 : -1
    }
    if (left.pct === right.pct) return left.index - right.index
    return mode === 'pct-desc' ? right.pct - left.pct : left.pct - right.pct
  })
  return ranked.map(entry => entry.row)
}

/** 把候选行拆成「置顶分区 + 列表区」并各自排序。 */
export function orderWatchlistRows(input: WatchlistOrderInput): WatchlistOrderResult {
  const pinnedKeys = new Set(input.pinned)
  const pinnedRows: Instrument[] = []
  const restRows: Instrument[] = []
  for (const row of input.rows) {
    if (pinnedKeys.has(input.keyOf(row))) pinnedRows.push(row)
    else restRows.push(row)
  }
  return {
    pinned: sortByMode(pinnedRows, input.sort.pinned, input.pctOf),
    rest: sortByMode(restRows, input.sort.rows, input.pctOf),
  }
}

/** 三态循环（表头点击的下一步）；UI 与测试同源，避免两处各写一遍顺序。 */
export function nextSortMode(mode: WatchlistSortMode): WatchlistSortMode {
  return mode === 'default' ? 'pct-desc' : mode === 'pct-desc' ? 'pct-asc' : 'default'
}
