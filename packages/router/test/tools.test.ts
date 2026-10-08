/**
 * routing_get / instruments_search 工具单测（离线）：provider 报告（含 selected-but-
 * missing 状态）、静态字典检索、动态全集并集与失败兜底、market 过滤与截断。
 */
import { describe, expect, it } from 'vitest'
import type { InstrumentAssetClass, InstrumentForm, MarketDataService } from '@dshtrading/api'
import { SYMBOL_CATALOG } from '../src/catalog.ts'
import { createInstrumentsSearchTool, createRoutingGetTool, type RouterToolServices } from '../src/tools.ts'

interface FakeRow {
  symbol: string
  name?: string
  form?: InstrumentForm
  assetClass?: InstrumentAssetClass
}

function fakeService(symbols: FakeRow[]): MarketDataService {
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

  it('静态字典数据完整（6 市场；futures/global 无静态种子，走动态全集）', () => {
    expect(Object.keys(SYMBOL_CATALOG).sort()).toEqual(['cn', 'crypto', 'futures', 'global', 'hk', 'us'])
    expect(SYMBOL_CATALOG.futures).toEqual([])
    expect(SYMBOL_CATALOG.global).toEqual([])
    expect(SYMBOL_CATALOG.crypto!.length).toBeGreaterThan(3)
    expect(SYMBOL_CATALOG.hk!.some(e => e.symbol === '00700.HK')).toBe(true)
    expect(SYMBOL_CATALOG.cn!.some(e => e.symbol === '600519.SH')).toBe(true)
  })
})

/** 检索响应（工具输出形状）。 */
interface SearchWire {
  query: string
  total: number
  matched: number
  results: Array<{ market: string; symbol: string; name?: string; form?: InstrumentForm; assetClass?: InstrumentAssetClass; source: string }>
}

describe('instruments_search 形态面（P4）', () => {
  it('用户搜索规范永续形时命中带 form/assetClass 的静态行（此前必空）', async () => {
    // Given crypto 无激活 provider（只剩内置静态字典）
    const services = makeServices({ registry: { active: () => undefined } })
    // When 用户搜索 BTCUSDT-SWAP
    const wire = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: 'BTCUSDT-SWAP', market: 'crypto' }))) as SearchWire
    // Then 命中永续行且形态与资产类别都在
    expect(wire.results).toContainEqual(expect.objectContaining({ symbol: 'BTCUSDT-SWAP', form: 'perp', assetClass: 'crypto' }))
  })

  it('用户搜索 TradFi 永续时命中带交易所元数据标注的行', async () => {
    // Given crypto 无激活 provider（只剩内置静态字典）
    const services = makeServices({ registry: { active: () => undefined } })
    // When 用户搜索 TSLA 与 XAU
    const equity = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: 'TSLA', market: 'crypto' }))) as SearchWire
    const metal = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: 'XAU', market: 'crypto' }))) as SearchWire
    // Then 股票合约标 equity、大宗合约标 commodity，形态都是永续
    expect(equity.results).toContainEqual(expect.objectContaining({ symbol: 'TSLAUSDT-SWAP', form: 'perp', assetClass: 'equity' }))
    expect(metal.results).toContainEqual(expect.objectContaining({ symbol: 'XAUUSDT-SWAP', form: 'perp', assetClass: 'commodity' }))
  })

  it('用户按形态过滤时只回单一形态', async () => {
    // Given crypto 无激活 provider（静态字典同时含现货与永续）
    const services = makeServices({ registry: { active: () => undefined } })
    // When 用户分别按 type=perp 与 type=spot 检索 BTC
    const perp = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: 'BTC', market: 'crypto', type: 'perp' }))) as SearchWire
    const spot = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: 'BTC', market: 'crypto', type: 'spot' }))) as SearchWire
    // Then 两侧都非空，且各自只回对应形态
    expect(perp.results.length).toBeGreaterThan(0)
    expect(perp.results.every(r => r.form === 'perp' && r.symbol.endsWith('-SWAP'))).toBe(true)
    expect(spot.results.length).toBeGreaterThan(0)
    expect(spot.results.every(r => r.form === 'spot' && !r.symbol.endsWith('-SWAP'))).toBe(true)
  })

  it('用户宽查询命中过多时现货与永续都不被截断吞掉', async () => {
    // Given 名册里 15 个永续都命中 BTC，只有 1 个现货命中
    const perps = Array.from({ length: 15 }, (_, i) => ({ symbol: `BTC${i}USDT-SWAP`, name: `BTC${i} 永续`, form: 'perp' as const, assetClass: 'crypto' as const }))
    const services = makeServices({ registry: { active: () => ({ provider: 'okx', service: fakeService([...perps, { symbol: 'BTCUSDT', name: 'BTC/USDT' }]) }) } })
    // When 用户搜索 BTC（默认 limit 10）
    const wire = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: 'BTC', market: 'crypto' }))) as SearchWire
    // Then 结果仍是 10 条，但两种形态都在（且能看出命中被截断）
    expect(wire.results).toHaveLength(10)
    expect(wire.results.some(r => r.form === 'perp')).toBe(true)
    expect(wire.results.some(r => r.form === 'spot')).toBe(true)
    expect(wire.matched).toBeGreaterThan(wire.total)
  })

  it('用户宽查询时 crypto 行排在 TradFi 永续前面（截断不吞 crypto）', async () => {
    // Given 名册里 equity 永续与 crypto 现货都能命中 "US"（静态字典里 US500 还是前缀命中）
    const services = makeServices({ registry: { active: () => ({ provider: 'okx', service: fakeService([
      { symbol: 'TSLAUSDT-SWAP', form: 'perp', assetClass: 'equity' },
      { symbol: 'USDCUSDT', form: 'spot', assetClass: 'crypto' },
    ]) }) } })
    // When 用户搜索 "US"
    const wire = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: 'US', market: 'crypto' }))) as SearchWire
    // Then 首条是 crypto 行，equity 永续被挤到 limit 之外
    expect(wire.results[0]).toMatchObject({ symbol: 'USDCUSDT', assetClass: 'crypto' })
    expect(wire.results.some(r => r.assetClass === 'equity')).toBe(false)
  })

  it('用户搜到过多命中时 exact 行排第一（先于 crypto 资产类别）', async () => {
    // Given 名册里 exact 行是 equity，另一条 crypto 行只包含查询词
    const services = makeServices({ registry: { active: () => ({ provider: 'okx', service: fakeService([
      { symbol: 'XTSLAUSDT-SWAP', form: 'perp', assetClass: 'crypto' },
      { symbol: 'TSLAUSDT-SWAP', form: 'perp', assetClass: 'equity' },
    ]) }) } })
    // When 用户搜索 TSLAUSDT-SWAP（exact）
    const wire = JSON.parse(String(await createInstrumentsSearchTool(services).execute({ query: 'TSLAUSDT-SWAP', market: 'crypto' }))) as SearchWire
    // Then exact 行排第一，包含式命中也在结果里
    expect(wire.results[0]?.symbol).toBe('TSLAUSDT-SWAP')
    expect(wire.results.map(r => r.symbol)).toContain('XTSLAUSDT-SWAP')
  })

  it('用户看到的内置字典形态标注自洽（永续 -SWAP + 资产类别）', () => {
    // Given 内置 crypto 静态字典
    const crypto = SYMBOL_CATALOG.crypto!
    const perps = crypto.filter(e => e.form === 'perp')
    // When 逐行核对形态与资产类别
    // Then 永续行一律带 -SWAP 后缀、crypto 永续充分覆盖、TradFi 行按元数据标注
    expect(perps.length).toBeGreaterThan(40)
    expect(perps.every(e => e.symbol.endsWith('-SWAP'))).toBe(true)
    expect(perps.filter(e => e.assetClass === 'crypto').length).toBeGreaterThan(40)
    expect(crypto).toContainEqual(expect.objectContaining({ symbol: 'TSLAUSDT-SWAP', assetClass: 'equity' }))
    expect(crypto).toContainEqual(expect.objectContaining({ symbol: 'XAUUSDT-SWAP', assetClass: 'commodity' }))
    // SPX-USDT-SWAP 是迷因币 SPX6900（instCategory=1），不得作为指数/TradFi 入表
    expect(crypto.some(e => e.symbol === 'SPXUSDT-SWAP')).toBe(false)
    // 显式标注 form 的行只能是永续；现货行按契约缺省（读侧 instrumentFormOf 裁决）
    expect(crypto.filter(e => e.form !== undefined).every(e => e.symbol.endsWith('-SWAP'))).toBe(true)
  })
})
