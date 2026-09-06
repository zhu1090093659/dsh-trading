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

    const kc50 = searchSymbols('cn', '科创50')
    expect(kc50.length).toBeGreaterThan(0)
    expect(kc50[0]?.symbol).toBe('000688.SH')
    expect(kc50[0]?.name).toBe('科创50')

    const kc50Pinyin = searchSymbols('cn', 'KC50')
    expect(kc50Pinyin.length).toBeGreaterThan(0)
    expect(kc50Pinyin[0]?.symbol).toBe('000688.SH')

    const shIndex = searchSymbols('cn', '上证指数')
    expect(shIndex.length).toBeGreaterThan(0)
    expect(shIndex[0]?.symbol).toBe('000001.SH')
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
