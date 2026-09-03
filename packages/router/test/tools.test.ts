/**
 * routing_get / instruments_search 工具单测（离线）：provider 报告（含 selected-but-
 * missing 状态）、静态字典检索、动态全集并集与失败兜底、market 过滤与截断。
 */
import { describe, expect, it } from 'vitest'
import type { MarketDataService } from '@dshtrading/api'
import { SYMBOL_CATALOG } from '../src/catalog.ts'
import { createInstrumentsSearchTool, createRoutingGetTool, type RouterToolServices } from '../src/tools.ts'

function fakeService(symbols: Array<{ symbol: string; name?: string }>): MarketDataService {
  return {
    getTicker: async (symbol) => ({ symbol, price: 1, timestamp: 1 }),
    getKlines: async () => [],
    subscribeTicker: () => ({ dispose() {} }),
    listInstruments: async () => symbols,
  }
}

function makeServices(overrides: Partial<RouterToolServices> = {}): RouterToolServices {
  return {
    activeProvider: (market) => ({ crypto: 'binance', us: 'alpaca', cn: 'tencent', hk: 'longbridge' }[market]),
    registry: {
      active: (market) => {
        if (market === 'crypto') return { provider: 'binance', service: fakeService([{ symbol: 'BTCUSDT', name: '比特币' }]) }
        return undefined
      },
    },
    ...overrides,
  }
}

describe('routing_get', () => {
  it('报告各市场 provider 与激活状态（serving / selected-but-missing / none）', async () => {
    const wire = JSON.parse(String(await createRoutingGetTool(makeServices()).execute({}))) as {
      markets: Array<{ market: string; provider: string; active: boolean; note: string }>
    }
    const crypto = wire.markets.find(m => m.market === 'crypto')!
    expect(crypto).toMatchObject({ provider: 'binance', active: true, note: 'serving' })
    const us = wire.markets.find(m => m.market === 'us')!
    expect(us).toMatchObject({ provider: 'alpaca', active: false })
    expect(us.note).toContain('selected but not registered')
  })
})

describe('instruments_search', () => {
  it('静态字典命中（中文名子串）+ 动态全集并集去重', async () => {
    const wire = JSON.parse(String(await createInstrumentsSearchTool(makeServices()).execute({ query: '比特', market: 'crypto' }))) as {
      total: number
      results: Array<{ symbol: string; source: string }>
    }
    expect(wire.results.some(r => r.symbol === 'BTCUSDT' && r.source === 'dynamic')).toBe(true)
    expect(wire.results.some(r => r.symbol === 'BTCUSDT' && r.source === 'catalog')).toBe(false) // 去重：动态优先
    expect(wire.results.some(r => r.symbol === 'BCHUSDT' && r.source === 'catalog')).toBe(true) // 比特币现金（字典兜底）
  })

  it('动态全集抛错 → 静态字典兜底不中断', async () => {
    const services = makeServices({
      registry: { active: () => ({ provider: 'binance', service: { ...fakeService([]), listInstruments: async () => { throw new Error('boom') } } }) },
    })
    const wire = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: 'BTC', market: 'crypto' }))) as { total: number }
    expect(wire.total).toBeGreaterThan(0)
  })

  it('market 过滤 + query 缺失报错', async () => {
    const wire = JSON.parse(String(await createInstrumentsSearchTool(makeServices()).execute({ query: 'AAPL', market: 'us' }))) as { results: Array<{ market: string }> }
    expect(wire.results.every(r => r.market === 'us')).toBe(true)
    await expect(createInstrumentsSearchTool(makeServices()).execute({})).rejects.toThrow(/missing required property/)
  })

  it('静态字典数据完整（4 市场 × 多行）', () => {
    expect(Object.keys(SYMBOL_CATALOG).sort()).toEqual(['cn', 'crypto', 'hk', 'us'])
    expect(SYMBOL_CATALOG.crypto!.length).toBeGreaterThan(3)
    expect(SYMBOL_CATALOG.hk!.some(e => e.symbol === '00700.HK')).toBe(true)
    expect(SYMBOL_CATALOG.cn!.some(e => e.symbol === '600519.SH')).toBe(true)
  })
})
