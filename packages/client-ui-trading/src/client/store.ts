/**
 * Client stores: a minimal observable engine (snapshot + subscribe, the
 * HostObservable face the slot renderer synthesizes use* hooks from) plus the
 * two trading-shell stores — instrument selection and per-market watchlists.
 *
 * Deliberately framework-free and dependency-free of SDK runtime code (no
 * @deepseek-ai/dsh-client-store import): these modules are unit-tested under
 * vitest, where seed-module resolution is unavailable. The only workspace
 * import is the watchlist seed table (@dsh-trading/watchlist, pure data) —
 * bundled inline by the client build; Agent 工具同源（见 seeds.ts）。Both stores
 * persist to localStorage (durable across reloads; single-user local app — no
 * server sync by design).
 */
import type { Instrument, MarketId } from './types.ts'
import { WATCHLIST_SEEDS } from '@dsh-trading/watchlist'

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
  if (sym.includes('USDT') || sym.includes('BTC') || sym.includes('ETH')) return 'crypto'
  return 'us'
}

export function createSelectionStore(): SelectionStore {
  const raw = readJson<Instrument | null>(SELECTION_KEY, null)
  const initialInstrument: Instrument | null = raw && typeof raw.symbol === 'string' && raw.symbol
    ? {
        market: raw.market && ['crypto', 'us', 'cn', 'hk'].includes(raw.market) ? (raw.market as MarketId) : inferMarket(raw.symbol),
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
        market: instrument.market && ['crypto', 'us', 'cn', 'hk'].includes(instrument.market) ? instrument.market : inferMarket(instrument.symbol),
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
    if (!['crypto', 'us', 'cn', 'hk'].includes(key) || !Array.isArray(rows)) continue
    const market = key as MarketId
    clean[market] = rows
      .filter((row): row is Instrument => Boolean(row && typeof row.symbol === 'string' && row.symbol))
      .map(row => ({
        market: row.market && ['crypto', 'us', 'cn', 'hk'].includes(row.market) ? row.market : market,
        symbol: row.symbol,
        ...(row.name ? { name: row.name } : {}),
      }))
  }
  return clean
}

export function createWatchlistStore(): WatchlistStore {
  const store = createObservable<Watchlists>(sanitizeWatchlists(readJson<Watchlists>(WATCHLIST_KEY, {})))
  const persist = (): void => { writeJson(WATCHLIST_KEY, store.getSnapshot()) }
  return {
    ...store,
    listFor(market) {
      const rows = store.getSnapshot()[market]
      if (rows !== undefined && rows.length > 0) return rows
      return DEFAULT_WATCHLISTS[market] ?? []
    },
    isCustomized(market) {
      const rows = store.getSnapshot()[market]
      return rows !== undefined && rows.length > 0
    },
    add(market, instrument) {
      const targetMarket = ['crypto', 'us', 'cn', 'hk'].includes(market) ? market : inferMarket(instrument.symbol)
      const sanitized: Instrument = {
        market: targetMarket,
        symbol: instrument.symbol,
        ...(instrument.name ? { name: instrument.name } : {}),
      }
      store.update((current) => {
        const rows = current[targetMarket] ?? []
        if (rows.some(row => row.symbol === sanitized.symbol)) return current
        return { ...current, [targetMarket]: [...rows, sanitized] }
      })
      persist()
    },
    remove(market, symbol) {
      const targetMarket = ['crypto', 'us', 'cn', 'hk'].includes(market) ? market : inferMarket(symbol)
      store.update((current) => {
        const rows = current[targetMarket] ?? []
        return { ...current, [targetMarket]: rows.filter(row => row.symbol !== symbol) }
      })
      persist()
    },
  }
}

/** Seed rows per market（SSOT 在 @dsh-trading/watchlist：agent 的 watchlist_list
 * 合并视图与 GUI 左栏展示同源，2026-09-02 agent 可见性修复）。 */
export const DEFAULT_WATCHLISTS = WATCHLIST_SEEDS as unknown as Record<MarketId, Instrument[]>

/** 一个市场的展示行：用户列表，未定制时回落种子列表。 */
export function rowsFor(watchlists: Watchlists, market: MarketId): Instrument[] {
  const rows = watchlists[market]
  if (rows !== undefined && rows.length > 0) return rows
  return DEFAULT_WATCHLISTS[market] ?? []
}

/** Chart intervals offered per market (connector-supported subsets only). */
export const MARKET_INTERVALS: Record<MarketId, string[]> = {
  crypto: ['5m', '15m', '30m', '1h', '4h', '1d', '1w'],
  us: ['5m', '15m', '30m', '1h', '1d', '1w', '1M'],
  cn: ['5m', '30m', '1d', '1w', '1M'],
  hk: ['5m', '15m', '30m', '1h', '1d', '1w', '1M'],
}
