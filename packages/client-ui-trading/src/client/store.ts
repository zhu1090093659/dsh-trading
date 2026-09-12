/**
 * Client stores: a minimal observable engine (snapshot + subscribe, the
 * HostObservable face the slot renderer synthesizes use* hooks from) plus the
 * two trading-shell stores — instrument selection and per-market watchlists.
 *
 * Deliberately framework-free and dependency-free of SDK runtime code (no
 * @deepseek-ai/dsh-client-store import): these modules are unit-tested under
 * vitest, where seed-module resolution is unavailable. The only workspace
 * import is the watchlist seed table (@dshtrading/watchlist, pure data) —
 * bundled inline by the client build; Agent 工具同源（见 seeds.ts）。Both stores
 * persist to localStorage (durable across reloads; single-user local app — no
 * server sync by design).
 */
import type { Instrument, MarketId, WatchlistGroupMeta } from './types.ts'
import { WATCHLIST_SEEDS } from '@dshtrading/watchlist'

/** Minimal observable face — matches the slot kit's HostObservable contract. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface WritableObservable<T> extends Observable<T> {
  set(next: T): void
  update(mutator: (current: T) => T): void
}

export function createObservable<T>(initial: T): WritableObservable<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    update(mutator) {
      this.set(mutator(snapshot))
    },
  }
}

/** localStorage read that survives unavailable storage (privacy mode) and corrupt JSON. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** localStorage write that survives unavailable storage. */
export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — session-only degradation */
  }
}

// ---------------------------------------------------------------------------
// Instrument selection (shared by MarketSidebar → QuoteStage)
// ---------------------------------------------------------------------------

const SELECTION_KEY = 'dshtrading.selection.v1'

export interface SelectionState {
  instrument: Instrument | null
}

export type SelectionStore = WritableObservable<SelectionState> & {
  select(instrument: Instrument): void
}

export function inferMarket(symbol?: string): MarketId {
  if (!symbol) return 'crypto'
  const sym = symbol.toUpperCase()
  if (sym.endsWith('.SH') || sym.endsWith('.SZ') || /^\d{6}$/.test(sym)) return 'cn'
  if (sym.endsWith('.HK') || /^\d{5}$/.test(sym)) return 'hk'
  if (/^[A-Z]{1,3}\d{2,4}(\.(SHF|DCE|CZC|INE|GFE|CFE))?$/.test(sym)) return 'futures'
  if (sym.includes('USDT') || sym.includes('BTC') || sym.includes('ETH')) return 'crypto'
  return 'us'
}

export function createSelectionStore(): SelectionStore {
  const raw = readJson<Instrument | null>(SELECTION_KEY, null)
  const initialInstrument: Instrument | null = raw && typeof raw.symbol === 'string' && raw.symbol
    ? {
        market: raw.market && ['crypto', 'us', 'cn', 'hk', 'futures'].includes(raw.market) ? (raw.market as MarketId) : inferMarket(raw.symbol),
        symbol: raw.symbol,
        ...(raw.name ? { name: raw.name } : {}),
      }
    : null
  const store = createObservable<SelectionState>({
    instrument: initialInstrument,
  })
  return {
    ...store,
    select(instrument) {
      const sanitized: Instrument = {
        market: instrument.market && ['crypto', 'us', 'cn', 'hk', 'futures'].includes(instrument.market) ? instrument.market : inferMarket(instrument.symbol),
        symbol: instrument.symbol,
        ...(instrument.name ? { name: instrument.name } : {}),
      }
      store.set({ instrument: sanitized })
      writeJson(SELECTION_KEY, sanitized)
    },
  }
}

// ---------------------------------------------------------------------------
// Per-market watchlists (the "自选" concept; seeded with defaults when empty)
// ---------------------------------------------------------------------------

const WATCHLIST_KEY = 'dshtrading.watchlist.v1'

export type Watchlists = Partial<Record<MarketId, Instrument[]>>

export interface WatchlistStore extends WritableObservable<Watchlists> {
  /** List for one market: the user's rows, or the market's seed list when untouched. */
  listFor(market: MarketId): Instrument[]
  /** Whether the user has customized this market's list (else seeds show). */
  isCustomized(market: MarketId): boolean
  add(market: MarketId, instrument: Instrument): void
  remove(market: MarketId, symbol: string): void
}

export function sameInstrument(a: Instrument, b: Instrument): boolean {
  return a.market === b.market && a.symbol === b.symbol
}

function sanitizeWatchlists(raw: Watchlists): Watchlists {
  const clean: Watchlists = {}
  for (const [key, rows] of Object.entries(raw)) {
    if (!['crypto', 'us', 'cn', 'hk', 'futures'].includes(key) || !Array.isArray(rows)) continue
    const market = key as MarketId
    clean[market] = rows
      .filter((row): row is Instrument => Boolean(row && typeof row.symbol === 'string' && row.symbol))
      .map(row => ({
        market: row.market && ['crypto', 'us', 'cn', 'hk', 'futures'].includes(row.market) ? row.market : market,
        symbol: row.symbol,
        ...(row.name ? { name: row.name } : {}),
        // 分组归属（issue #82）：只收非空字符串 id，去重；空集不落键
        ...sanitizeGroupsField(row.groups),
      }))
  }
  return clean
}

/** 行上 groups 字段清洗（issue #82；坏项剔除、去重、空集 → 键缺省）。 */
function sanitizeGroupsField(raw: unknown): { groups?: string[] } | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item === 'string' && item) seen.add(item)
  }
  return seen.size > 0 ? { groups: [...seen] } : undefined
}

export function createWatchlistStore(): WatchlistStore {
  const store = createObservable<Watchlists>(sanitizeWatchlists(readJson<Watchlists>(WATCHLIST_KEY, {})))
  const persist = (): void => { writeJson(WATCHLIST_KEY, store.getSnapshot()) }
  return {
    ...store,
    listFor(market) {
      const rows = store.getSnapshot()[market]
      if (Array.isArray(rows)) return rows
      return DEFAULT_WATCHLISTS[market] ?? []
    },
    isCustomized(market) {
      const rows = store.getSnapshot()[market]
      return Array.isArray(rows)
    },
    add(market, instrument) {
      const targetMarket = ['crypto', 'us', 'cn', 'hk', 'futures'].includes(market) ? market : inferMarket(instrument.symbol)
      const sanitized: Instrument = {
        market: targetMarket,
        symbol: instrument.symbol,
        ...(instrument.name ? { name: instrument.name } : {}),
        // 分组视图下添加标的直落归属（issue #82；host 侧 parseInstrumentBody 同步放行）
        ...sanitizeGroupsField(instrument.groups),
      }
      store.update((current) => {
        const rows = current[targetMarket] ?? []
        if (rows.some(row => row.symbol === sanitized.symbol)) return current
        return { ...current, [targetMarket]: [...rows, sanitized] }
      })
      persist()
    },
    remove(market, symbol) {
      const targetMarket = ['crypto', 'us', 'cn', 'hk', 'futures'].includes(market) ? market : inferMarket(symbol)
      store.update((current) => {
        const existing = current[targetMarket]
        const baseRows = Array.isArray(existing) ? existing : (DEFAULT_WATCHLISTS[targetMarket] ?? [])
        return { ...current, [targetMarket]: baseRows.filter(row => row.symbol !== symbol) }
      })
      persist()
    },
  }
}

/** Seed rows per market（SSOT 在 @dshtrading/watchlist：agent 的 watchlist_list
 * 合并视图与 GUI 左栏展示同源，2026-09-02 agent 可见性修复）。 */
export const DEFAULT_WATCHLISTS = WATCHLIST_SEEDS as unknown as Record<MarketId, Instrument[]>

/** 一个市场的展示行：用户列表（若已定制，包括空数组），未定制时回落种子列表。 */
export function rowsFor(watchlists: Watchlists, market: MarketId): Instrument[] {
  const rows = watchlists[market]
  if (Array.isArray(rows)) return rows
  return DEFAULT_WATCHLISTS[market] ?? []
}

// ---------------------------------------------------------------------------
// 自定义分组（issue #82）：注册表镜像 + 活动分组过滤 UI 态
// ---------------------------------------------------------------------------

const GROUPS_KEY = 'dshtrading.watchlist-groups.v1'
const ACTIVE_GROUP_KEY = 'dshtrading.watchlist.active-group.v1'

export interface WatchlistGroupsState {
  /** 分组注册表镜像（host SSOT；降级时本地直写）。 */
  groups: WatchlistGroupMeta[]
  /** 活动分组过滤（null = 全部/市场视图）。纯本地 UI 态，不进 host。 */
  activeGroupId: string | null
}

/** 分组写操作结果（桥面业务结果镜像；'unavailable' = 桥缺席/网络失败）。 */
export type WatchlistGroupOpResult =
  | { ok: true; group: WatchlistGroupMeta }
  | { ok: false; reason: 'duplicate' | 'not-found' | 'unavailable' }

/** 分组 store 客户端全 face：镜像维护 + host-first 写路径（wireHostWatchlistSync 接管替换）。 */
export interface WatchlistGroupsStoreApi extends WritableObservable<WatchlistGroupsState> {
  /** 注册表镜像直写（rename 原位替换，不挪顺序；create 追加尾部）。 */
  upsertGroup(group: WatchlistGroupMeta): void
  /** 注册表镜像摘除（活动分组指向被删组时归位 null）。 */
  removeGroupLocal(id: string): void
  /** 切活动分组（本地持久化，不进 host）。 */
  setActiveGroup(id: string | null): void
  create(name: string): Promise<WatchlistGroupOpResult>
  rename(id: string, name: string): Promise<WatchlistGroupOpResult>
  delete(id: string): Promise<boolean>
  /** 行级 membership（member=false 仅摘归属不删行）。 */
  assignMember(id: string, market: string, symbol: string, member: boolean, name?: string): Promise<boolean>
}

function sanitizeGroupsRegistry(raw: unknown): WatchlistGroupMeta[] {
  if (!Array.isArray(raw)) return []
  const out: WatchlistGroupMeta[] = []
  for (const item of raw) {
    const group = item as Partial<WatchlistGroupMeta> | null
    if (group !== null && typeof group === 'object' && typeof group.id === 'string' && group.id
      && typeof group.name === 'string' && typeof group.createdAt === 'number') {
      out.push({ id: group.id, name: group.name, createdAt: group.createdAt })
    }
  }
  return out
}

export function createWatchlistGroupsStore(): WatchlistGroupsStoreApi {
  const persisted = readJson<{ groups?: unknown }>(GROUPS_KEY, {})
  const persistedActive = readJson<unknown>(ACTIVE_GROUP_KEY, null)
  const store = createObservable<WatchlistGroupsState>({
    groups: sanitizeGroupsRegistry(persisted.groups),
    activeGroupId: typeof persistedActive === 'string' && persistedActive ? persistedActive : null,
  })
  const persist = (): void => { writeJson(GROUPS_KEY, { groups: store.getSnapshot().groups }) }

  const newLocalId = (): string => `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const upsert = (group: WatchlistGroupMeta): void => {
    store.update((current) => {
      const index = current.groups.findIndex(entry => entry.id === group.id)
      if (index < 0) return { ...current, groups: [...current.groups, group] }
      const groups = [...current.groups]
      groups[index] = group
      return { ...current, groups }
    })
    persist()
  }

  return {
    ...store,
    upsertGroup: upsert,
    removeGroupLocal(id) {
      store.update((current) => ({
        ...current,
        groups: current.groups.filter(entry => entry.id !== id),
        activeGroupId: current.activeGroupId === id ? null : current.activeGroupId,
      }))
      persist()
    },
    setActiveGroup(id) {
      store.set({ ...store.getSnapshot(), activeGroupId: id })
      writeJson(ACTIVE_GROUP_KEY, id)
    },
    // 以下四个是桥缺席时的本地降级路径（启动时 wireHostWatchlistSync 无条件替换为 host-first；
    // 桥不可用 = fail-closed 不改本地，与 add/remove 的 host-first 语义一致）。
    async create(name) {
      const trimmed = name.trim()
      if (!trimmed) return { ok: false, reason: 'unavailable' }
      if (store.getSnapshot().groups.some(entry => entry.name === trimmed)) return { ok: false, reason: 'duplicate' }
      const group: WatchlistGroupMeta = { id: newLocalId(), name: trimmed, createdAt: Date.now() }
      upsert(group)
      return { ok: true, group }
    },
    async rename(id, name) {
      const trimmed = name.trim()
      if (!trimmed) return { ok: false, reason: 'unavailable' }
      const existing = store.getSnapshot().groups.find(entry => entry.id === id)
      if (existing === undefined) return { ok: false, reason: 'not-found' }
      if (store.getSnapshot().groups.some(entry => entry.id !== id && entry.name === trimmed)) return { ok: false, reason: 'duplicate' }
      const group = { ...existing, name: trimmed }
      upsert(group)
      return { ok: true, group }
    },
    async delete() {
      return false
    },
    async assignMember() {
      return false
    },
  }
}

/** 本地镜像的行级 membership 写（host-first 包装成功后调用；未定制市场按种子物化，与 host 行为同构）。 */
export function applyLocalMembership(
  watchlists: WritableObservable<Watchlists>,
  market: MarketId,
  groupId: string,
  symbol: string,
  member: boolean,
): void {
  watchlists.update((current) => {
    const base = Array.isArray(current[market]) ? current[market] ?? [] : DEFAULT_WATCHLISTS[market] ?? []
    let changed = false
    const nextRows = base.map((row) => {
      if (row.symbol !== symbol) return row
      const groups = row.groups ?? []
      const has = groups.includes(groupId)
      if (member === has) return row
      changed = true
      const next = member ? [...groups, groupId] : groups.filter(entry => entry !== groupId)
      // 显式重建行（不能 { ...row } 展开——移出后 groups 键会被原行带回）。
      return {
        market: row.market,
        symbol: row.symbol,
        ...(row.name !== undefined ? { name: row.name } : {}),
        ...(next.length > 0 ? { groups: next } : {}),
      }
    })
    if (!changed) return current
    return { ...current, [market]: nextRows }
  })
}

/** Chart intervals offered per market (connector-supported subsets only). */
export const MARKET_INTERVALS: Record<MarketId, string[]> = {
  crypto: ['5m', '15m', '30m', '1h', '4h', '1d', '1w'],
  us: ['5m', '15m', '30m', '1h', '1d', '1w', '1M'],
  cn: ['5m', '30m', '1d', '1w', '1M'],
  hk: ['5m', '15m', '30m', '1h', '1d', '1w', '1M'],
  // 期货：上游日K可回溯，分钟只有当日分时——只上日线及以上周期，避免单日分钟冒充历史。
  futures: ['1d', '1w', '1M'],
}
