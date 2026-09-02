/**
 * @dsh-trading/watchlist —— host 侧自选股与选中标的存储（issue #32 / P3）。
 *
 * 背景：自选股原先只存浏览器 localStorage（dshtrading.watchlist.v1），node 半的
 * Agent 触达不了——四块能力中 Agent 工具面唯一完全空白的一块。owner 2026-08-31
 * 裁决（D3）：存储升位 localStorage → host file store（含一次性迁移），localStorage
 * 降级为缓存镜像，不再是 SSOT。
 *
 * 本模块（纯类型 + 内存 store，浏览器安全）：
 * - `WatchlistsMap`：按 market 分桶的多列表行（rows 只存用户定制行；市场种子列表
 *   属客户端展示回退，不进 host store——空 market = 未定制，客户端回落种子）。
 * - `SelectionRecord`：跨市场选中标的（watchlist_select 工具与左栏点击同源）。
 * - `./plugin` 子路径：file store（~/.dsh/watchlists.json、~/.dsh/selection.json，
 *   tmp+rename 原子写）+ host 平面工具 watchlist_list/add/remove/select（全会话可见，
 *   owner 裁决 D4；select/add/remove 后 emit tradingEvents('watchlists'|'selection')）。
 *
 * 词汇纪律：symbol 用市场规范形（docs/symbol-vocabulary.md），本包不做归一化
 * （写入方负责——工具参数与桥端点均原样落盘）。
 *
 * @module @dsh-trading/watchlist
 */

/** 跨市场标的行（market 为市场词汇 slug：crypto | us | cn | hk，开放新市场）。 */
export interface WatchlistInstrument {
  market: string
  symbol: string
  /** 展示名（可选；工具添加可缺省，客户端以 symbol 兜底展示）。 */
  name?: string
}

/** 多列表自选：market → 用户定制行数组（空数组/缺键 = 未定制）。 */
export type WatchlistsMap = Record<string, WatchlistInstrument[]>

/** 选中标的记录（中栏切图的 SSOT）。 */
export interface SelectionRecord {
  instrument: WatchlistInstrument | null
}

export interface WatchlistStore {
  /** 全量读取（host SSOT；客户端启动同步与 SSE 重拉都走这里）。 */
  list(): Promise<WatchlistsMap>
  /** 全量替换（桥 PUT / 客户端迁移导入）。 */
  save(map: WatchlistsMap): Promise<void>
  /** 追加一行（同 market 内按 symbol 去重）；返回是否新增。 */
  add(market: string, instrument: WatchlistInstrument): Promise<boolean>
  /** 移除一行；返回是否 existed。 */
  remove(market: string, symbol: string): Promise<boolean>
}

export interface SelectionStore {
  get(): Promise<SelectionRecord>
  set(record: SelectionRecord): Promise<void>
}

/** 内存版自选 store（单测用）。 */
export function createMemoryWatchlistStore(initial: WatchlistsMap = {}): WatchlistStore {
  let map: WatchlistsMap = { ...initial }
  return {
    async list() {
      return map
    },
    async save(next) {
      map = { ...next }
    },
    async add(market, instrument) {
      const rows = map[market] ?? []
      if (rows.some(row => row.symbol === instrument.symbol)) return false
      map = { ...map, [market]: [...rows, { ...instrument }] }
      return true
    },
    async remove(market, symbol) {
      const rows = map[market] ?? []
      const next = rows.filter(row => row.symbol !== symbol)
      if (next.length === rows.length) return false
      map = { ...map, [market]: next }
      return true
    },
  }
}

// 各市场种子自选行（GUI 展示回退 = Agent 工具合并视图，同源单例）。
export { WATCHLIST_SEEDS, effectiveWatchlistRows, watchlistRowSource } from './seeds.ts'

/** 内存版选中 store（单测用）。 */
export function createMemorySelectionStore(initial: SelectionRecord = { instrument: null }): SelectionStore {
  let current: SelectionRecord = { ...initial }
  return {
    async get() {
      return current
    },
    async set(record) {
      current = { ...record, instrument: record.instrument === null ? null : { ...record.instrument } }
    },
  }
}
