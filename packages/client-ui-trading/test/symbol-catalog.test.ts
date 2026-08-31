import { describe, expect, it } from 'vitest'
import {
  getMergedCatalog,
  searchAllMarkets,
  searchSymbols,
  setDynamicCatalog,
} from '../src/client/symbol-catalog.ts'

describe('symbol-catalog', () => {
  it('searches symbols by prefix from static catalog', () => {
    const btc = searchSymbols('crypto', 'BTC')
    expect(btc.length).toBeGreaterThan(0)
    expect(btc[0]?.symbol).toBe('BTCUSDT')
  })

  it('searches symbols by chinese name from static catalog', () => {
    const maotai = searchSymbols('cn', '茅台')
    expect(maotai.length).toBeGreaterThan(0)
    expect(maotai[0]?.symbol).toBe('600519.SH')
  })

  it('merges dynamic catalog and allows searching new symbols', () => {
    setDynamicCatalog('crypto', [
      { symbol: 'NEWCOINUSDT', name: 'NewCoin' },
      { symbol: 'BTCUSDT', name: 'BTC/USDT' },
    ])
    const merged = getMergedCatalog('crypto')
    const hasNewCoin = merged.some(e => e.symbol === 'NEWCOINUSDT')
    expect(hasNewCoin).toBe(true)
    const btc = merged.find(e => e.symbol === 'BTCUSDT')
    expect(btc?.name).toBe('比特币')
    const results = searchSymbols('crypto', 'NEWCOIN')
    expect(results.some(e => e.symbol === 'NEWCOINUSDT')).toBe(true)
  })

  it('searchAllMarkets searches across all markets with market tag', () => {
    const results = searchAllMarkets('AAPL')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.market).toBe('us')
    expect(results[0]?.symbol).toBe('AAPL')
  })

  it('empty query returns empty array', () => {
    expect(searchSymbols('crypto', '')).toEqual([])
    expect(searchSymbols('crypto', '   ')).toEqual([])
    expect(searchAllMarkets('')).toEqual([])
  })
})
