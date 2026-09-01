/**
 * 自选股 host SSOT 同步（issue #32 / P3）：
 *
 * - 启动同步：GET /watchlists → 有行则以 host 为准覆盖本地 observable；
 *   host 为空且本地 localStorage 有定制行 → 一次性迁移导入（POST /watchlists/import，
 *   host 非空时服务端拒绝，幂等）→ 重拉 host。
 * - 选中标的：GET /selection → host 有值则覆盖本地（中栏切图 SSOT）。
 * - 变更 host-first：add/remove/select 先写 host（PUT/POST/DELETE），成功后才更新
 *   本地 observable（localStorage 由原 store 持久化，降级为缓存镜像）。
 * - SSE：'watchlists' / 'selection' 失效信号 → 重拉 host 覆盖本地（左栏实时增删行、
 *   watchlist_select 工具驱动中栏切图）。
 *
 * 市场种子列表（DEFAULT_WATCHLISTS）不进 host：host 无行的 market 客户端照旧
 * 回落种子展示（rowsFor），迁移只搬用户定制行。
 */
import type { Instrument, MarketId } from './types.ts'
import type { SelectionStore, WatchlistStore } from './store.ts'
import {
  addHostWatchlistRow,
  fetchHostSelection,
  fetchHostWatchlists,
  importHostWatchlists,
  putHostSelection,
  removeHostWatchlistRow,
  subscribeTradingEvents,
  type HostWatchlists,
} from './api.ts'

function isHostWatchlists(value: HostWatchlists): boolean {
  return Object.values(value).some(rows => (rows?.length ?? 0) > 0)
}

/** 把 host 行映射回客户端 Watchlists（market 断言到 MarketId 词汇）。 */
function toLocalWatchlists(host: HostWatchlists): Partial<Record<MarketId, Instrument[]>> {
  const out: Partial<Record<MarketId, Instrument[]>> = {}
  for (const [market, rows] of Object.entries(host)) {
    if (!Array.isArray(rows) || rows.length === 0) continue
    out[market as MarketId] = rows.map(row => ({
      market: row.market as MarketId,
      symbol: row.symbol,
      ...(row.name !== undefined ? { name: row.name } : {}),
    }))
  }
  return out
}

export interface HostWatchlistSyncOptions {
  watchlists: WatchlistStore
  selection: SelectionStore
}

/** 启动 host 同步 + 变更接管 + SSE 订阅；返回清理函数（插件卸载语义）。 */
export function wireHostWatchlistSync(options: HostWatchlistSyncOptions): () => void {
  const { watchlists, selection } = options
  const disposables: Array<() => void> = []

  const syncFromHost = async (): Promise<void> => {
    try {
      const host = await fetchHostWatchlists()
      watchlists.set(toLocalWatchlists(host))
    } catch {
      /* 桥不可用 → 本地镜像维持现状（不劣于升级前） */
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
          if (Array.isArray(rows) && rows.length > 0) customized[market] = rows
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

  // SSE 失效信号：工具写入（watchlist_add/remove/select）或其它标签页变更 → 重拉覆盖。
  disposables.push(subscribeTradingEvents({
    watchlists: () => { void syncFromHost() },
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
