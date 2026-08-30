/**
 * Client stores: a minimal observable engine (snapshot + subscribe, the
 * HostObservable face the slot renderer synthesizes use* hooks from) plus the
 * two trading-shell stores — instrument selection and per-market watchlists.
 *
 * Deliberately framework-free and dependency-free (no @deepseek-ai/dsh-client-store
 * import): these modules are unit-tested under vitest, where seed-module
 * resolution is unavailable. Both stores persist to localStorage (durable
 * across reloads; single-user local app — no server sync by design).
 */
import type { Instrument, MarketId } from './types.ts'

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

export function createSelectionStore(): SelectionStore {
  const store = createObservable<SelectionState>({
    instrument: readJson<Instrument | null>(SELECTION_KEY, null),
  })
  return {
    ...store,
    select(instrument) {
      store.set({ instrument })
      writeJson(SELECTION_KEY, instrument)
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

export function createWatchlistStore(): WatchlistStore {
  const store = createObservable<Watchlists>(readJson<Watchlists>(WATCHLIST_KEY, {}))
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
      store.update((current) => {
        const rows = current[market] ?? []
        if (rows.some(row => row.symbol === instrument.symbol)) return current
        return { ...current, [market]: [...rows, instrument] }
      })
      persist()
    },
    remove(market, symbol) {
      store.update((current) => {
        const rows = current[market] ?? []
        return { ...current, [market]: rows.filter(row => row.symbol !== symbol) }
      })
      persist()
    },
  }
}

/** Seed rows per market (connector-validated symbol formats). */
export const DEFAULT_WATCHLISTS: Record<MarketId, Instrument[]> = {
  crypto: [
    { market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin' },
    { market: 'crypto', symbol: 'ETHUSDT', name: 'Ethereum' },
    { market: 'crypto', symbol: 'SOLUSDT', name: 'Solana' },
    { market: 'crypto', symbol: 'BNBUSDT', name: 'BNB' },
  ],
  us: [
    { market: 'us', symbol: 'AAPL', name: '苹果' },
    { market: 'us', symbol: 'MSFT', name: '微软' },
    { market: 'us', symbol: 'NVDA', name: '英伟达' },
    { market: 'us', symbol: 'GOOGL', name: '谷歌' },
  ],
  cn: [
    { market: 'cn', symbol: '600519', name: '贵州茅台' },
    { market: 'cn', symbol: '000001', name: '平安银行' },
    { market: 'cn', symbol: '601318', name: '中国平安' },
  ],
  hk: [
    { market: 'hk', symbol: '00700', name: '腾讯控股' },
    { market: 'hk', symbol: '09988', name: '阿里巴巴-W' },
    { market: 'hk', symbol: '03690', name: '美团-W' },
  ],
}

/** 一个市场的展示行：用户列表，未定制时回落种子列表。 */
export function rowsFor(watchlists: Watchlists, market: MarketId): Instrument[] {
  const rows = watchlists[market]
  if (rows !== undefined && rows.length > 0) return rows
  return DEFAULT_WATCHLISTS[market] ?? []
}

// ---------------------------------------------------------------------------
// Shell mode: quotes（默认，中栏=行情面板，会话壳隐藏）/ chat（官方会话 UI）
// ---------------------------------------------------------------------------

const MODE_KEY = 'dshtrading.mode.v1'

export type ShellMode = 'quotes' | 'chat'

export interface ModeState {
  mode: ShellMode
}

export interface ModeStore extends WritableObservable<ModeState> {
  setMode(mode: ShellMode): void
}

export function createModeStore(): ModeStore {
  const store = createObservable<ModeState>({ mode: readJson<ShellMode>(MODE_KEY, 'quotes') })
  return {
    ...store,
    setMode(mode) {
      store.set({ mode })
      writeJson(MODE_KEY, mode)
    },
  }
}

/** Chart intervals offered per market (connector-supported subsets only). */
export const MARKET_INTERVALS: Record<MarketId, string[]> = {
  crypto: ['15m', '1h', '4h', '1d', '1w'],
  us: ['1d', '1w', '1M'],
  cn: ['1d', '1w', '1M'],
  hk: ['1d', '1w', '1M'],
}
