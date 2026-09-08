/**
 * 自选股 host SSOT 同步（issue #32 / P3；分组扩展 issue #82）：
 *
 * - 启动同步：GET /watchlists → 有行则以 host 为准覆盖本地 observable；
 *   host 为空且本地 localStorage 有定制行 → 一次性迁移导入（POST /watchlists/import，
 *   host 非空时服务端拒绝，幂等）→ 重拉 host。
 * - 分组注册表（issue #82）：GET /watchlist-groups 启动拉取 + SSE 'watchlists'
 *   失效信号重拉（注册表与成员关系共用一个失效信号，客户端两表一起刷）。
 * - 选中标的：GET /selection → host 有值则覆盖本地（中栏切图 SSOT）。
 * - 变更 host-first：add/remove/select 与分组的 create/rename/delete/assignMember
 *   先写 host，成功后才更新本地 observable（localStorage 由原 store 持久化，
 *   降级为缓存镜像）。
 * - SSE：'watchlists' / 'selection' 失效信号 → 重拉 host 覆盖本地（左栏实时增删行、
 *   watchlist_select 工具驱动中栏切图）。
 *
 * 市场种子列表（DEFAULT_WATCHLISTS）不进 host：host 无行的 market 客户端照旧
 * 回落种子展示（rowsFor），迁移只搬用户定制行；种子行入组时 host 桥自动物化
 * （POST /watchlist-group-members 的行缺席分支），本地镜像同构物化。
 */
import type { Instrument, MarketId, WatchlistGroupMeta } from './types.ts'
import type { SelectionStore, WatchlistGroupsStoreApi, WatchlistGroupOpResult, WatchlistStore } from './store.ts'
import { applyLocalMembership } from './store.ts'
import {
  addHostWatchlistGroupMember,
  addHostWatchlistRow,
  createHostWatchlistGroup,
  deleteHostWatchlistGroup,
  fetchHostSelection,
  fetchHostWatchlistGroups,
  fetchHostWatchlists,
  importHostWatchlists,
  putHostSelection,
  removeHostWatchlistGroupMember,
  removeHostWatchlistRow,
  renameHostWatchlistGroup,
  subscribeTradingEvents,
  type HostWatchlists,
} from './api.ts'

function isHostWatchlists(value: HostWatchlists): boolean {
  return Object.keys(value).length > 0
}

/** 把 host 行映射回客户端 Watchlists（market 断言到 MarketId 词汇；groups 透传）。 */
function toLocalWatchlists(host: HostWatchlists): Partial<Record<MarketId, Instrument[]>> {
  const out: Partial<Record<MarketId, Instrument[]>> = {}
  for (const [market, rows] of Object.entries(host)) {
    if (!Array.isArray(rows)) continue
    out[market as MarketId] = rows.map(row => ({
      market: row.market as MarketId,
      symbol: row.symbol,
      ...(row.name !== undefined ? { name: row.name } : {}),
      ...(Array.isArray(row.groups) && row.groups.length > 0 ? { groups: [...row.groups] } : {}),
    }))
  }
  return out
}

export interface HostWatchlistSyncOptions {
  watchlists: WatchlistStore
  selection: SelectionStore
  /** 分组 store（issue #82；create/rename/delete/assignMember 在此被替换为 host-first）。 */
  groups: WatchlistGroupsStoreApi
}

/** 启动 host 同步 + 变更接管 + SSE 订阅；返回清理函数（插件卸载语义）。 */
export function wireHostWatchlistSync(options: HostWatchlistSyncOptions): () => void {
  const { watchlists, selection, groups } = options
  const disposables: Array<() => void> = []

  const syncFromHost = async (): Promise<void> => {
    try {
      const host = await fetchHostWatchlists()
      watchlists.set(toLocalWatchlists(host))
    } catch {
      /* 桥不可用 → 本地镜像维持现状（不劣于升级前） */
    }
  }

  const syncGroupsFromHost = async (): Promise<void> => {
    const hostGroups = await fetchHostWatchlistGroups()
    if (hostGroups !== null) {
      const next = hostGroups as WatchlistGroupMeta[]
      const { activeGroupId } = groups.getSnapshot()
      // 活动分组被别处删除 → 归位「全部」（防悬挂 id 过滤出空视图）。
      if (activeGroupId !== null && !next.some(group => group.id === activeGroupId)) {
        groups.setActiveGroup(null)
      }
      // 全量覆盖注册表镜像；activeGroupId 是本地 UI 态，原位保留。
      groups.set({ ...groups.getSnapshot(), groups: next })
    }
  }

  const boot = async (): Promise<void> => {
    try {
      const host = await fetchHostWatchlists()
      if (isHostWatchlists(host)) {
        // host 已有定制行 → host 为准（可能来自工具写入或另一标签页）。
        watchlists.set(toLocalWatchlists(host))
      } else {
        // host 为空 → 尝试一次性迁移本地 localStorage 定制行（幂等）。
        const local = watchlists.getSnapshot()
        const customized: HostWatchlists = {}
        for (const [market, rows] of Object.entries(local)) {
          if (Array.isArray(rows)) customized[market] = rows
        }
        if (Object.keys(customized).length > 0) {
          const imported = await importHostWatchlists(customized)
          if (imported) {
            const after = await fetchHostWatchlists()
            watchlists.set(toLocalWatchlists(after))
          }
          // 导入被拒（host 非空竞态）→ 下面统一 host 拉取兜底。
        }
      }
      // 分组注册表：host 拉取覆盖镜像（host 无文件 → 空表，本地降级镜像清空——
      // host SSOT 语义；UI 在空表时可继续创建）。
      await syncGroupsFromHost()
      // 选中标的：host 有值则覆盖（SSOT）；host 空保持本地。
      const hostSelection = await fetchHostSelection()
      if (hostSelection !== null) {
        selection.set({ instrument: hostSelection as Instrument })
      }
    } catch {
      /* 迁移/同步失败不阻断启动 */
    }
  }
  void boot()

  // 变更接管：host-first（成功后才更新本地 observable；localStorage 由原方法持久化为镜像）。
  const originalAdd = watchlists.add.bind(watchlists)
  watchlists.add = (market: MarketId, instrument: Instrument): void => {
    void (async () => {
      const ok = await addHostWatchlistRow(instrument)
      if (ok) originalAdd(market, instrument)
      else console.warn('[dsh-trading] watchlist add failed on host — local state unchanged')
    })()
  }
  const originalRemove = watchlists.remove.bind(watchlists)
  watchlists.remove = (market: MarketId, symbol: string): void => {
    void (async () => {
      const ok = await removeHostWatchlistRow(market, symbol)
      if (ok) originalRemove(market, symbol)
      else console.warn('[dsh-trading] watchlist remove failed on host — local state unchanged')
    })()
  }
  const originalSelect = selection.select.bind(selection)
  selection.select = (instrument: Instrument): void => {
    void (async () => {
      const ok = await putHostSelection(instrument)
      if (ok) originalSelect(instrument)
      else console.warn('[dsh-trading] selection update failed on host — local state unchanged')
    })()
  }

  // 分组写路径接管（issue #82）：host 成功后才动本地镜像；失败 fail-closed。
  groups.create = async (name: string): Promise<WatchlistGroupOpResult> => {
    const result = await createHostWatchlistGroup(name)
    if (result.ok) groups.upsertGroup(result.group)
    return result.ok ? { ok: true, group: result.group } : result
  }
  groups.rename = async (id: string, name: string): Promise<WatchlistGroupOpResult> => {
    const result = await renameHostWatchlistGroup(id, name)
    if (result.ok) groups.upsertGroup(result.group)
    return result.ok ? { ok: true, group: result.group } : result
  }
  groups.delete = async (id: string): Promise<boolean> => {
    const ok = await deleteHostWatchlistGroup(id)
    if (!ok) return false
    groups.removeGroupLocal(id)
    // 本地镜像同步剥离归属（SSE 重拉随后全量覆盖，这里保 UI 即时性）。
    stripLocalGroup(watchlists, id)
    return true
  }
  groups.assignMember = async (id: string, market: string, symbol: string, member: boolean, name?: string): Promise<boolean> => {
    const ok = member
      ? await addHostWatchlistGroupMember(id, market, symbol, name)
      : await removeHostWatchlistGroupMember(id, market, symbol)
    if (!ok) {
      console.warn('[dsh-trading] watchlist group membership update failed on host — local state unchanged')
      return false
    }
    applyLocalMembership(watchlists, market as MarketId, id, symbol, member)
    return true
  }

  // SSE 失效信号：工具写入（watchlist_add/remove/select）或其它标签页变更 → 重拉覆盖。
  disposables.push(subscribeTradingEvents({
    watchlists: () => {
      void syncFromHost()
      void syncGroupsFromHost()
    },
    selection: () => {
      void (async () => {
        const instrument = await fetchHostSelection()
        if (instrument !== null) selection.set({ instrument: instrument as Instrument })
      })()
    },
  }))

  return () => {
    for (const dispose of disposables) dispose()
  }
}

/** 本地镜像全市场剥离某分组归属（删分组时保 UI 即时；SSE 重拉兜底）。 */
function stripLocalGroup(watchlists: WatchlistStore, groupId: string): void {
  watchlists.update((current) => {
    const next: Partial<Record<MarketId, Instrument[]>> = {}
    let changed = false
    for (const [market, rows] of Object.entries(current)) {
      if (!Array.isArray(rows)) continue
      let marketChanged = false
      const nextRows = rows.map((row) => {
        if (!row.groups?.includes(groupId)) return row
        marketChanged = true
        const rest = row.groups.filter(entry => entry !== groupId)
        // 显式重建行（不能 { ...row } 展开——groups 键会被原行带回）。
        return {
          market: row.market,
          symbol: row.symbol,
          ...(row.name !== undefined ? { name: row.name } : {}),
          ...(rest.length > 0 ? { groups: rest } : {}),
        }
      })
      next[market as MarketId] = nextRows
      changed = changed || marketChanged
    }
    if (!changed) return current
    // 未定制市场的种子基线不被镜像化（strip 只会命中已有定制行的市场）。
    return next
  })
}
