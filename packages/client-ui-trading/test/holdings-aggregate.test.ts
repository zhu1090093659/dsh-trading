/**
 * 统一资产台账聚合引擎单测（Issue #65，契约 §6.2/§7）：
 * 多来源合并、加权成本、缺成本价、FX stale 降级、缺汇率未折算分区、
 * 多币种、未知市场旧 paper 数据、批量价优先/自带 markPrice 兜底。
 */
import { describe, expect, it } from 'vitest'
import { aggregateHoldings, detailRowOf, UNKNOWN_CURRENCY_BUCKET } from '../src/client/holdings-aggregate.ts'
import type { FxSnapshot, TaggedPosition } from '../src/client/holdings-types.ts'

function pos(overrides: Partial<TaggedPosition> & Pick<TaggedPosition, 'symbol' | 'size' | 'origin' | 'account' | 'market'>): TaggedPosition {
  return {
    side: 'long',
    kind: overrides.origin === 'paper' ? 'sim' : 'real',
    timestamp: 1,
    ...overrides,
  }
}

const FX_USD: FxSnapshot = {
  base: 'USD',
  // rates[c] = 1 单位 c 折合多少 USD
  rates: { USD: 1, USDT: 1, CNY: 0.14, HKD: 0.128 },
  asOf: 1000,
  stale: false,
}

describe('aggregateHoldings 明细行', () => {
  it('批量盯市价优先于持仓自带 markPrice；缺批量价回退 markPrice', () => {
    const p = pos({ symbol: 'BTCUSDT', size: 1, origin: 'live', account: 'binance', market: 'crypto', entryPrice: 80_000, markPrice: 90_000 })
    const withBatch = aggregateHoldings([p], { 'crypto:BTCUSDT': 100_000 }, FX_USD)
    expect(withBatch.rows[0]?.markPrice).toBe(100_000)
    expect(withBatch.rows[0]?.marketValue).toBe(100_000)
    const withoutBatch = aggregateHoldings([p], {}, FX_USD)
    expect(withoutBatch.rows[0]?.markPrice).toBe(90_000)
    expect(withoutBatch.rows[0]?.marketValue).toBe(90_000)
  })

  it('uPnL：有成本价按现价重算；缺成本价回退持仓预计算；皆无 → undefined', () => {
    const withCost = pos({ symbol: 'AAPL', size: 10, origin: 'live', account: 'ibkr', market: 'us', entryPrice: 100 })
    const row1 = detailRowOf(withCost, { 'us:AAPL': 120 }, FX_USD)
    expect(row1.unrealizedPnl).toBe(200) // (120-100)×10
    expect(row1.unrealizedPnlBase).toBe(200)

    const noCostPreset = pos({ symbol: 'AAPL', size: 10, origin: 'live', account: 'ibkr', market: 'us', unrealizedPnl: 55 })
    const row2 = detailRowOf(noCostPreset, { 'us:AAPL': 120 }, FX_USD)
    expect(row2.unrealizedPnl).toBe(55) // 连接器预计算原样透传

    const noCostImported = pos({ symbol: '00700', size: 100, origin: 'imported', account: '富途', market: 'hk', holdingId: 'hd-1' })
    const row3 = detailRowOf(noCostImported, { 'hk:00700': 400 }, FX_USD)
    expect(row3.unrealizedPnl).toBeUndefined()
    expect(row3.unrealizedPnlBase).toBeUndefined()
  })

  it('币种推导：position.currency 优先，缺省按 market（§2 推导表）', () => {
    const cryptoPos = pos({ symbol: 'BTCUSDT', size: 1, origin: 'paper', account: '模拟账户', market: 'crypto', entryPrice: 1 })
    expect(detailRowOf(cryptoPos, { 'crypto:BTCUSDT': 2 }, FX_USD).currency).toBe('USDT')
    const cnPos = pos({ symbol: '600519', size: 100, origin: 'imported', account: '华泰', market: 'cn', currency: 'CNY', holdingId: 'hd-2' })
    expect(detailRowOf(cnPos, { 'cn:600519': 1500 }, FX_USD).currency).toBe('CNY')
    const unknownMarket = pos({ symbol: 'OLD', size: 1, origin: 'paper', account: '模拟账户', market: undefined, entryPrice: 1 })
    expect(detailRowOf(unknownMarket, {}, FX_USD).currency).toBeUndefined()
  })

  it('基准币恒等：currency === fx.base 时按 1 折算（不依赖 rates 回带基准项）', () => {
    const usd = pos({ symbol: 'AAPL', size: 2, origin: 'live', account: 'ibkr', market: 'us', entryPrice: 100 })
    const row = detailRowOf(usd, { 'us:AAPL': 150 }, { base: 'USD', rates: {}, asOf: 1, stale: false })
    expect(row.marketValueBase).toBe(300)
    expect(row.converted).toBe(true)
  })
})

describe('aggregateHoldings 汇总行', () => {
  it('多来源合并：同 market:symbol 的 paper+live+imported 聚成一行，来源/账户分布齐全', () => {
    const rows = [
      pos({ symbol: 'BTCUSDT', size: 1, origin: 'paper', account: '模拟账户', market: 'crypto', entryPrice: 90_000 }),
      pos({ symbol: 'BTCUSDT', size: 2, origin: 'live', account: 'binance', market: 'crypto', entryPrice: 100_000 }),
      pos({ symbol: 'BTCUSDT', size: 3, origin: 'imported', account: '币安截图', market: 'crypto', entryPrice: 110_000, holdingId: 'hd-3' }),
    ]
    const agg = aggregateHoldings(rows, { 'crypto:BTCUSDT': 100_000 }, FX_USD)
    expect(agg.summaries).toHaveLength(1)
    const s = agg.summaries[0]!
    expect(s.key).toBe('crypto:BTCUSDT')
    expect(s.totalSize).toBe(6)
    expect(s.origins).toEqual(['paper', 'live', 'imported'])
    expect(s.accounts).toEqual(['模拟账户', 'binance', '币安截图'])
    expect(s.members).toHaveLength(3)
    // 市值 = 6 × 100,000 USDT，USDT≈USD
    expect(s.marketValue).toBe(600_000)
    expect(s.marketValueBase).toBe(600_000)
  })

  it('加权成本：只计有成本价的行，按 size 加权', () => {
    const rows = [
      pos({ symbol: 'AAPL', size: 10, origin: 'live', account: 'ibkr', market: 'us', entryPrice: 100 }),
      pos({ symbol: 'AAPL', size: 20, origin: 'imported', account: '截图', market: 'us', entryPrice: 200, holdingId: 'hd-4' }),
      pos({ symbol: 'AAPL', size: 5, origin: 'imported', account: '无成本截图', market: 'us', holdingId: 'hd-5' }), // 缺成本价
    ]
    const agg = aggregateHoldings(rows, { 'us:AAPL': 150 }, FX_USD)
    const s = agg.summaries[0]!
    // (100×10 + 200×20) / 30 = 166.67（5 股无成本行不进分子也不进分母）
    expect(s.weightedCost).toBeCloseTo(5000 / 30, 6)
    expect(s.totalSize).toBe(35)
    expect(s.marketValue).toBe(35 * 150)
  })

  it('全部缺成本价 → weightedCost undefined；市值照常', () => {
    const rows = [
      pos({ symbol: '00700', size: 100, origin: 'imported', account: '富途', market: 'hk', holdingId: 'hd-6' }),
      pos({ symbol: '00700', size: 200, origin: 'imported', account: '富途', market: 'hk', holdingId: 'hd-7' }),
    ]
    const agg = aggregateHoldings(rows, { 'hk:00700': 400 }, FX_USD)
    const s = agg.summaries[0]!
    expect(s.weightedCost).toBeUndefined()
    expect(s.unrealizedPnl).toBeUndefined()
    expect(s.marketValue).toBe(300 * 400)
  })

  it('混合币种同标的 → 原币合计/加权成本 undefined，折算市值仍给出', () => {
    const rows = [
      pos({ symbol: 'BTCUSDT', size: 1, origin: 'live', account: 'binance', market: 'crypto', entryPrice: 100_000, currency: 'USDT' }),
      pos({ symbol: 'BTCUSDT', size: 1, origin: 'imported', account: '截图', market: 'crypto', entryPrice: 100_000, currency: 'USD', holdingId: 'hd-8' }),
    ]
    const agg = aggregateHoldings(rows, { 'crypto:BTCUSDT': 100_000 }, FX_USD)
    const s = agg.summaries[0]!
    expect(s.currency).toBeUndefined()
    expect(s.weightedCost).toBeUndefined()
    expect(s.marketValue).toBeUndefined()
    expect(s.marketValueBase).toBe(200_000) // USDT≈USD≈1
  })

  it('未知市场旧 paper 数据：键 unknown:<symbol>，不进批量盯市，回退自带 markPrice', () => {
    const legacy = pos({ symbol: 'BTCUSDT', size: 0.5, origin: 'paper', account: '模拟账户', market: undefined, entryPrice: 80_000, markPrice: 90_000 })
    const agg = aggregateHoldings([legacy], { 'crypto:BTCUSDT': 100_000 }, FX_USD)
    expect(agg.summaries[0]?.key).toBe('unknown:BTCUSDT')
    expect(agg.summaries[0]?.market).toBeUndefined()
    // 批量价键是 crypto:BTCUSDT，不匹配未知市场行 → 用自带 90,000
    expect(agg.rows[0]?.markPrice).toBe(90_000)
    // 币种未知 → 进未折算分区
    expect(agg.rows[0]?.converted).toBe(false)
    expect(agg.unconverted).toEqual([{ currency: UNKNOWN_CURRENCY_BUCKET, amount: 45_000 }])
    expect(agg.totalBase).toBe(0)
    expect(agg.approximate).toBe(true)
  })
})

describe('aggregateHoldings 顶部小计与 FX 降级', () => {
  it('多币种折算总资产 + 分来源/分币种小计', () => {
    const rows = [
      pos({ symbol: 'AAPL', size: 10, origin: 'live', account: 'ibkr', market: 'us', entryPrice: 100 }),           // 1500 USD
      pos({ symbol: '600519', size: 10, origin: 'imported', account: '华泰', market: 'cn', entryPrice: 1400, holdingId: 'hd-9' }), // 15000 CNY → 2100 USD
      pos({ symbol: '00700', size: 100, origin: 'imported', account: '富途', market: 'hk', entryPrice: 380, holdingId: 'hd-10' }), // 40000 HKD → 5120 USD
      pos({ symbol: 'BTCUSDT', size: 1, origin: 'paper', account: '模拟账户', market: 'crypto', entryPrice: 90_000 }), // 100000 USDT → 100000 USD
    ]
    const agg = aggregateHoldings(rows, {
      'us:AAPL': 150, 'cn:600519': 1500, 'hk:00700': 400, 'crypto:BTCUSDT': 100_000,
    }, FX_USD)
    expect(agg.totalBase).toBeCloseTo(1500 + 15000 * 0.14 + 40000 * 0.128 + 100_000, 6)
    expect(agg.approximate).toBe(false)
    expect(agg.unconverted).toEqual([])
    // 分来源小计（固定 paper/live/imported 序）
    expect(agg.byOrigin.map(o => o.origin)).toEqual(['paper', 'live', 'imported'])
    expect(agg.byOrigin[0]?.totalBase).toBe(100_000)
    expect(agg.byOrigin[1]?.totalBase).toBe(1500)
    expect(agg.byOrigin[2]?.totalBase).toBeCloseTo(2100 + 5120, 6)
    expect(agg.byOrigin[2]?.count).toBe(2)
    // 分币种小计（币种代码升序）：原币金额 + 折算金额
    expect(agg.byCurrency.map(c => c.currency)).toEqual(['CNY', 'HKD', 'USD', 'USDT'])
    expect(agg.byCurrency[0]).toEqual({ currency: 'CNY', amount: 15_000, amountBase: 2100 })
    expect(agg.byCurrency[3]).toEqual({ currency: 'USDT', amount: 100_000, amountBase: 100_000 })
  })

  it('FX stale：仍折算但 approximate=true（总资产仍给出但标注近似）', () => {
    const staleFx: FxSnapshot = { ...FX_USD, stale: true }
    const rows = [pos({ symbol: '600519', size: 10, origin: 'imported', account: '华泰', market: 'cn', entryPrice: 1400, holdingId: 'hd-11' })]
    const agg = aggregateHoldings(rows, { 'cn:600519': 1500 }, staleFx)
    expect(agg.fxStale).toBe(true)
    expect(agg.totalBase).toBeCloseTo(15000 * 0.14, 6)
    expect(agg.approximate).toBe(true)
    expect(agg.unconverted).toEqual([])
  })

  it('缺汇率 → 该币种进未折算分区，总资产只含可折算部分且标近似', () => {
    const partialFx: FxSnapshot = { base: 'USD', rates: { USD: 1, USDT: 1 }, asOf: 1, stale: true } // 恒等兜底：无 CNY/HKD
    const rows = [
      pos({ symbol: 'AAPL', size: 10, origin: 'live', account: 'ibkr', market: 'us', entryPrice: 100 }),
      pos({ symbol: '600519', size: 10, origin: 'imported', account: '华泰', market: 'cn', entryPrice: 1400, holdingId: 'hd-12' }),
    ]
    const agg = aggregateHoldings(rows, { 'us:AAPL': 150, 'cn:600519': 1500 }, partialFx)
    expect(agg.totalBase).toBe(1500) // 只有 USD 行计入
    expect(agg.unconverted).toEqual([{ currency: 'CNY', amount: 15_000 }])
    expect(agg.approximate).toBe(true)
    // 分来源小计同样携带未折算分区
    const imported = agg.byOrigin.find(o => o.origin === 'imported')!
    expect(imported.totalBase).toBe(0)
    expect(imported.unconverted).toEqual([{ currency: 'CNY', amount: 15_000 }])
    // 汇总行：CNY 行无折算市值
    const cnSummary = agg.summaries.find(s => s.key === 'cn:600519')!
    expect(cnSummary.marketValue).toBe(15_000)
    expect(cnSummary.marketValueBase).toBeUndefined()
  })

  it('fx 快照缺席 → 一切不折算，总资产 0 且标近似（有市值时）', () => {
    const rows = [pos({ symbol: 'AAPL', size: 10, origin: 'live', account: 'ibkr', market: 'us', entryPrice: 100 })]
    const agg = aggregateHoldings(rows, { 'us:AAPL': 150 })
    expect(agg.base).toBe('USD')
    expect(agg.totalBase).toBe(0)
    expect(agg.unconverted).toEqual([{ currency: 'USD', amount: 1500 }])
    expect(agg.approximate).toBe(true)
  })

  it('空持仓 → 全零不近似', () => {
    const agg = aggregateHoldings([], {}, FX_USD)
    expect(agg.totalBase).toBe(0)
    expect(agg.approximate).toBe(false)
    expect(agg.summaries).toEqual([])
    expect(agg.byOrigin).toEqual([])
    expect(agg.byCurrency).toEqual([])
  })

  it('无市值行（无现价）：不进未折算分区，不计总资产', () => {
    const rows = [pos({ symbol: 'AAPL', size: 10, origin: 'live', account: 'ibkr', market: 'us', entryPrice: 100 })]
    const agg = aggregateHoldings(rows, {}, FX_USD) // 无批量价且无 markPrice
    expect(agg.rows[0]?.marketValue).toBeUndefined()
    expect(agg.unconverted).toEqual([])
    expect(agg.totalBase).toBe(0)
    expect(agg.approximate).toBe(false)
  })
})
