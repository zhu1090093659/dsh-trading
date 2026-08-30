/**
 * Client 纯逻辑单测：observable、自选 store（含种子回落与持久化）、
 * 行选择辅助。localStorage 用 vi.stubGlobal 假件。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type StoreMap = Map<string, string>
const backing: StoreMap = new Map()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => { backing.set(key, value) },
  removeItem: (key: string) => { backing.delete(key) },
})

import {
  createObservable,
  createWatchlistStore,
  rowsFor,
  sameInstrument,
} from '../src/client/store.ts'

beforeEach(() => { backing.clear() })

describe('createObservable', () => {
  it('set/update 触发订阅，退订后不再触发', () => {
    const store = createObservable({ count: 0 })
    const seen: number[] = []
    const off = store.subscribe(() => { seen.push(store.getSnapshot().count) })
    store.set({ count: 1 })
    store.update(current => ({ count: current.count + 1 }))
    off()
    store.set({ count: 99 })
    expect(seen).toEqual([1, 2])
    expect(store.getSnapshot().count).toBe(99)
  })
})

describe('createWatchlistStore', () => {
  it('未定制 → 种子列表；add/remove 定制后持久化', () => {
    const store = createWatchlistStore()
    expect(store.isCustomized('crypto')).toBe(false)
    expect(store.listFor('crypto').map(row => row.symbol)).toContain('BTCUSDT')

    store.add('crypto', { market: 'crypto', symbol: 'TONUSDT' })
    expect(store.isCustomized('crypto')).toBe(true)
    expect(store.listFor('crypto').some(row => row.symbol === 'TONUSDT')).toBe(true)

    store.add('crypto', { market: 'crypto', symbol: 'TONUSDT' })
    expect(store.listFor('crypto').filter(row => row.symbol === 'TONUSDT')).toHaveLength(1)

    store.remove('crypto', 'TONUSDT')
    expect(store.listFor('crypto').some(row => row.symbol === 'TONUSDT')).toBe(false)
  })

  it('重载后从 localStorage 恢复（持久化契约）', () => {
    const first = createWatchlistStore()
    first.add('us', { market: 'us', symbol: 'TSLA', name: '特斯拉' })
    const second = createWatchlistStore()
    expect(second.listFor('us').some(row => row.symbol === 'TSLA')).toBe(true)
  })

  it('rowsFor：定制列表优先，空回落种子', () => {
    expect(rowsFor({}, 'hk').map(row => row.symbol)).toContain('00700')
    expect(rowsFor({ hk: [{ market: 'hk', symbol: '00001', name: '长和' }] }, 'hk'))
      .toEqual([{ market: 'hk', symbol: '00001', name: '长和' }])
  })

  it('sameInstrument：market+symbol 二元组判定', () => {
    expect(sameInstrument({ market: 'us', symbol: 'AAPL' }, { market: 'us', symbol: 'AAPL' })).toBe(true)
    expect(sameInstrument({ market: 'us', symbol: 'AAPL' }, { market: 'crypto', symbol: 'AAPL' })).toBe(false)
  })
})
