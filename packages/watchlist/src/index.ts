/**
 * @dshtrading/watchlist —— host 侧自选股与选中标的存储（issue #32 / P3）。
 *
 * 背景：自选股原先只存浏览器 localStorage（dshtrading.watchlist.v1），node 半的
 * Agent 触达不了——四块能力中 Agent 工具面唯一完全空白的一块。owner 2026-08-31
 * 裁决（D3）：存储升位 localStorage → host file store（含一次性迁移），localStorage
 * 降级为缓存镜像，不再是 SSOT。
 *
 * 本模块（纯类型 + 内存 store，浏览器安全）：
 * - `WatchlistsMap`：按 market 分桶的多列表行（rows 只存用户定制行；市场种子列表
 *   属客户端展示回退，不进 host store——空 market = 未定制，客户端回落种子）。
 *   行可带 `groups`（自定义分组 id 多归属，issue #82）；分组注册表另存
 *   watchlist-groups.json（`./file-store.ts` 的 groups store）。
 * - `SelectionRecord`：跨市场选中标的（watchlist_select 工具与左栏点击同源）。
 * - `./plugin` 子路径：file store（~/.dsh/watchlists.json、~/.dsh/selection.json、
 *   ~/.dsh/watchlist-groups.json，tmp+rename 原子写）+ host 平面工具
 *   watchlist_list/add/remove/select（全会话可见，owner 裁决 D4；select/add/remove
 *   后 emit tradingEvents('watchlists'|'selection')）。
 *
 * 词汇纪律：symbol 用市场规范形（docs/symbol-vocabulary.md），本包不做归一化
 * （写入方负责——工具参数与桥端点均原样落盘）。
 *
 * @module @dshtrading/watchlist
 */

/** 跨市场标的行（market 为市场词汇 slug：crypto | us | cn | hk，开放新市场）。 */
export interface WatchlistInstrument {
  market: string
  symbol: string
  /** 展示名（可选；工具添加可缺省，客户端以 symbol 兜底展示）。 */
  name?: string
  /**
   * 所属自定义分组 id 数组（issue #82；多归属，一行可入多组；缺省/空 = 未分组）。
   * 分组注册表（名称等元数据）在 ./file-store.ts 的 groups store，行上只存 id。
   */
  groups?: string[]
}

/** 多列表自选：market → 用户定制行数组（空数组/缺键 = 未定制）。 */
export type WatchlistsMap = Record<string, WatchlistInstrument[]>

/** 自定义分组注册表行（issue #82；成员关系在标的行的 groups 字段，此处只存元数据）。 */
export interface WatchlistGroup {
  id: string
  /** 展示名（桥面保证 trim 非空；同名单向拒绝）。 */
  name: string
  createdAt: number
}

/** 分组写操作结果（桥面转业务 ok:false + reason；'duplicate' = 同名已存在，'not-found' = id 不存在）。 */
export interface WatchlistGroupWriteResult {
  group?: WatchlistGroup
  error?: 'duplicate' | 'not-found'
}

/** 自定义分组注册表 store（元数据；成员关系的读写走 WatchlistStore.assignGroup/stripGroup）。 */
export interface WatchlistGroupsStore {
  list(): Promise<WatchlistGroup[]>
  create(name: string): Promise<WatchlistGroupWriteResult>
  rename(id: string, name: string): Promise<WatchlistGroupWriteResult>
  remove(id: string): Promise<boolean>
}

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
  /** 加入/移出分组（issue #82）：行缺席或归属无变化返回 false（读改写入队串行化）。 */
  assignGroup(market: string, symbol: string, groupId: string, member: boolean): Promise<boolean>
  /** 清掉所有行上的某分组归属（删分组时调用）；返回清洗行数，无变化不落盘。 */
  stripGroup(groupId: string): Promise<number>
}

export interface SelectionStore {
  get(): Promise<SelectionRecord>
  set(record: SelectionRecord): Promise<void>
}

import { WATCHLIST_SEEDS } from './seeds.ts'

/** 行规范化副本：groups 空数组不落键，保持落盘/输出形状干净。 */
export function normalizeWatchlistRow(row: WatchlistInstrument): WatchlistInstrument {
  const groups = Array.isArray(row.groups) ? [...new Set(row.groups.filter(item => typeof item === 'string' && item))] : []
  return {
    market: row.market,
    symbol: row.symbol,
    ...(row.name !== undefined ? { name: row.name } : {}),
    ...(groups.length > 0 ? { groups } : {}),
  }
}

/** 新分组 id（时间戳 base36 + 随机尾，进程内唯一即可——注册表单文件单写者）。 */
export function newWatchlistGroupId(): string {
  return `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
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
      map = { ...map, [market]: [...rows, normalizeWatchlistRow(instrument)] }
      return true
    },
    async remove(market, symbol) {
      const existing = map[market]
      const rows = Array.isArray(existing) ? existing : (WATCHLIST_SEEDS[market] ?? [])
      const next = rows.filter(row => row.symbol !== symbol)
      if (next.length === rows.length) return false
      map = { ...map, [market]: next }
      return true
    },
    async assignGroup(market, symbol, groupId, member) {
      const rows = map[market]
      if (!Array.isArray(rows)) return false
      const index = rows.findIndex(row => row.symbol === symbol)
      if (index < 0) return false
      const base = rows[index]
      const current = Array.isArray(base.groups) ? base.groups : []
      if (member === current.includes(groupId)) return false
      const nextGroups = member ? [...current, groupId] : current.filter(id => id !== groupId)
      // 显式重建行（不能 { ...base } 展开——移出后 groups 键会被原行带回）。
      const nextRows = [...rows]
      nextRows[index] = normalizeWatchlistRow({
        market: base.market,
        symbol: base.symbol,
        ...(base.name !== undefined ? { name: base.name } : {}),
        ...(nextGroups.length > 0 ? { groups: nextGroups } : {}),
      })
      map = { ...map, [market]: nextRows }
      return true
    },
    async stripGroup(groupId) {
      let cleaned = 0
      const next: WatchlistsMap = {}
      for (const [market, rows] of Object.entries(map)) {
        if (!Array.isArray(rows)) continue
        let changed = false
        const nextRows = rows.map((row) => {
          const groups = Array.isArray(row.groups) ? row.groups : []
          if (!groups.includes(groupId)) return row
          changed = true
          cleaned++
          const rest = groups.filter(id => id !== groupId)
          return normalizeWatchlistRow({
            market: row.market,
            symbol: row.symbol,
            ...(row.name !== undefined ? { name: row.name } : {}),
            ...(rest.length > 0 ? { groups: rest } : {}),
          })
        })
        next[market] = changed ? nextRows : rows
      }
      if (cleaned > 0) map = next
      return cleaned
    },
  }
}

/** 内存版分组注册表 store（单测用）。同名拒绝（trim 后精确匹配）；调用方负责非空校验。 */
export function createMemoryWatchlistGroupsStore(initial: WatchlistGroup[] = []): WatchlistGroupsStore {
  let groups: WatchlistGroup[] = [...initial]
  return {
    async list() {
      return [...groups]
    },
    async create(name) {
      if (groups.some(group => group.name === name)) return { error: 'duplicate' }
      const group: WatchlistGroup = { id: newWatchlistGroupId(), name, createdAt: Date.now() }
      groups = [...groups, group]
      return { group }
    },
    async rename(id, name) {
      const existing = groups.find(group => group.id === id)
      if (existing === undefined) return { error: 'not-found' }
      if (groups.some(group => group.id !== id && group.name === name)) return { error: 'duplicate' }
      const next = groups.map(group => (group.id === id ? { ...group, name } : group))
      groups = next
      return { group: { ...existing, name } }
    },
    async remove(id) {
      const next = groups.filter(group => group.id !== id)
      if (next.length === groups.length) return false
      groups = next
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
