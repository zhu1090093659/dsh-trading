import { describe, expect, it } from 'vitest'
import { MARKET_INDICES, getMarketSessionStatus } from '../src/client/market-status.ts'

describe('MARKET_INDICES', () => {
  it('defines core indices for all 4 markets', () => {
    expect(MARKET_INDICES.cn.map(d => d.symbol)).toEqual(['sh000001', 'sz399001', 'sz399006'])
    expect(MARKET_INDICES.hk.map(d => d.symbol)).toEqual(['HSI', 'HSTECH', 'HSCEI'])
    expect(MARKET_INDICES.us.map(d => d.symbol)).toEqual(['^GSPC', '^IXIC', '^DJI'])
    expect(MARKET_INDICES.crypto.map(d => d.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
  })
})

describe('getMarketSessionStatus', () => {
  it('crypto is continuous 7x24 trading', () => {
    const status = getMarketSessionStatus('crypto')
    expect(status.isOpen).toBe(true)
    expect(status.statusKey).toBe('status.trading')
    expect(status.color).toBe('#2ba471')
  })

  it('cn market session status calculation', () => {
    // 2026-08-31 is Monday
    // 09:20 Shanghai (01:20 UTC) -> auction
    const auctionTime = new Date('2026-08-31T01:20:00.000Z')
    expect(getMarketSessionStatus('cn', auctionTime)).toMatchObject({
      statusKey: 'status.auction',
      isOpen: false,
      color: '#e37318',
    })

    // 10:00 Shanghai (02:00 UTC) -> trading
    const morningTrading = new Date('2026-08-31T02:00:00.000Z')
    expect(getMarketSessionStatus('cn', morningTrading)).toMatchObject({
      statusKey: 'status.trading',
      isOpen: true,
      color: '#2ba471',
    })

    // 12:00 Shanghai (04:00 UTC) -> midday break
    const midday = new Date('2026-08-31T04:00:00.000Z')
    expect(getMarketSessionStatus('cn', midday)).toMatchObject({
      statusKey: 'status.midday',
      isOpen: false,
      color: '#e37318',
    })

    // 14:00 Shanghai (06:00 UTC) -> trading
    const afternoonTrading = new Date('2026-08-31T06:00:00.000Z')
    expect(getMarketSessionStatus('cn', afternoonTrading)).toMatchObject({
      statusKey: 'status.trading',
      isOpen: true,
      color: '#2ba471',
    })

    // 16:00 Shanghai (08:00 UTC) -> closed
    const closedTime = new Date('2026-08-31T08:00:00.000Z')
    expect(getMarketSessionStatus('cn', closedTime)).toMatchObject({
      statusKey: 'status.closed',
      isOpen: false,
      color: '#8e95a3',
    })

    // 2026-08-30 is Sunday -> closed
    const weekendTime = new Date('2026-08-30T04:00:00.000Z')
    expect(getMarketSessionStatus('cn', weekendTime)).toMatchObject({
      statusKey: 'status.closed',
      isOpen: false,
      color: '#8e95a3',
    })
  })

  it('hk market session status calculation', () => {
    // 2026-08-31 is Monday
    // 09:10 HK (01:10 UTC) -> auction
    const auctionTime = new Date('2026-08-31T01:10:00.000Z')
    expect(getMarketSessionStatus('hk', auctionTime)).toMatchObject({
      statusKey: 'status.auction',
      isOpen: false,
    })

    // 10:00 HK (02:00 UTC) -> trading
    const tradingTime = new Date('2026-08-31T02:00:00.000Z')
    expect(getMarketSessionStatus('hk', tradingTime)).toMatchObject({
      statusKey: 'status.trading',
      isOpen: true,
    })

    // 12:30 HK (04:30 UTC) -> midday
    const midday = new Date('2026-08-31T04:30:00.000Z')
    expect(getMarketSessionStatus('hk', midday)).toMatchObject({
      statusKey: 'status.midday',
      isOpen: false,
    })

    // 16:05 HK (08:05 UTC) -> closing auction
    const closingAuction = new Date('2026-08-31T08:05:00.000Z')
    expect(getMarketSessionStatus('hk', closingAuction)).toMatchObject({
      statusKey: 'status.auction',
      isOpen: false,
    })

    // 17:00 HK (09:00 UTC) -> closed
    const closed = new Date('2026-08-31T09:00:00.000Z')
    expect(getMarketSessionStatus('hk', closed)).toMatchObject({
      statusKey: 'status.closed',
      isOpen: false,
    })
  })

  it('us market session status calculation', () => {
    // 2026-08-31 is Monday (EDT, UTC-4)
    // 06:00 ET (10:00 UTC) -> preMarket
    const preMarket = new Date('2026-08-31T10:00:00.000Z')
    expect(getMarketSessionStatus('us', preMarket)).toMatchObject({
      statusKey: 'status.preMarket',
      isOpen: false,
    })

    // 11:00 ET (15:00 UTC) -> trading
    const trading = new Date('2026-08-31T15:00:00.000Z')
    expect(getMarketSessionStatus('us', trading)).toMatchObject({
      statusKey: 'status.trading',
      isOpen: true,
    })

    // 17:00 ET (21:00 UTC) -> afterHours
    const afterHours = new Date('2026-08-31T21:00:00.000Z')
    expect(getMarketSessionStatus('us', afterHours)).toMatchObject({
      statusKey: 'status.afterHours',
      isOpen: false,
    })

    // 21:00 ET (2026-09-01T01:00 UTC) -> closed
    const closed = new Date('2026-09-01T01:00:00.000Z')
    expect(getMarketSessionStatus('us', closed)).toMatchObject({
      statusKey: 'status.closed',
      isOpen: false,
    })
  })
})
