import { describe, expect, it } from 'vitest'
import { parsePlaceOrderPayload, parseWatchlistPayload } from '../src/client/toolview-parse.ts'

describe('parsePlaceOrderPayload', () => {
  const dryRunReceipt = JSON.stringify({
    status: 'filled',
    dryRun: true,
    note: 'DRY-RUN — simulated fill; no order was sent to OKX.',
    id: 'dry-123',
    instId: 'BTC-USDT',
    side: 'buy',
    type: 'limit',
    quantity: 0.01,
    price: 50000,
    reference: { source: 'okx-public-ticker', price: 49950 },
    timestamp: 1,
  })

  it('parses a dry-run receipt', () => {
    const parsed = parsePlaceOrderPayload('{"instId":"BTC-USDT","side":"buy","type":"limit","quantity":0.01,"price":50000}', dryRunReceipt)
    expect(parsed?.state).toBe('filled')
    expect(parsed?.dryRun).toBe(true)
    expect(parsed?.symbol).toBe('BTC-USDT')
    expect(parsed?.referencePrice).toBe(49950)
  })

  it('parses a gate rejection', () => {
    const wire = JSON.stringify({ status: 'rejected', code: 'GATE_LIVE_TRADING_OFF', message: 'liveTrading is not enabled' })
    const parsed = parsePlaceOrderPayload('{"instId":"BTC-USDT","side":"buy"}', wire)
    expect(parsed?.state).toBe('rejected')
    expect(parsed?.message).toContain('liveTrading')
  })

  it('parses a live receipt (no dryRun field) and symbol aliases', () => {
    const wire = JSON.stringify({ id: 'ord-1', symbol: 'AAPL', side: 'buy', type: 'market', quantity: 10 })
    const parsed = parsePlaceOrderPayload('{"symbol":"AAPL","side":"buy","type":"market","quantity":10}', wire)
    expect(parsed?.state).toBe('filled')
    expect(parsed?.dryRun).toBe(false)
    expect(parsed?.symbol).toBe('AAPL')
  })

  it('returns null for non-JSON / running', () => {
    expect(parsePlaceOrderPayload('{}', 'plain text')).toBeNull()
    expect(parsePlaceOrderPayload('{}', '')).toBeNull()
  })
})

describe('parseWatchlistPayload', () => {
  it('parses watchlist_add added=true', () => {
    const wire = JSON.stringify({ ok: true, added: true, note: 'Added 00700 (hk) to the watchlist.' })
    const parsed = parseWatchlistPayload('watchlist_add', '{"market":"hk","symbol":"00700","name":"腾讯控股"}', wire)
    expect(parsed?.action).toBe('add')
    expect(parsed?.added).toBe(true)
    expect(parsed?.symbol).toBe('00700')
    expect(parsed?.name).toBe('腾讯控股')
  })

  it('parses watchlist_add dedup (added=false)', () => {
    const wire = JSON.stringify({ ok: true, added: false, note: 'already in the watchlist' })
    const parsed = parseWatchlistPayload('watchlist_add', '{"market":"hk","symbol":"00700"}', wire)
    expect(parsed?.added).toBe(false)
  })

  it('parses watchlist_select', () => {
    const wire = JSON.stringify({ ok: true, selected: { market: 'us', symbol: 'AAPL', name: 'Apple' } })
    const parsed = parseWatchlistPayload('watchlist_select', '{"market":"us","symbol":"AAPL"}', wire)
    expect(parsed?.action).toBe('select')
    expect(parsed?.name).toBe('Apple')
  })

  it('returns null on ok:false', () => {
    expect(parseWatchlistPayload('watchlist_add', '{}', JSON.stringify({ ok: false }))).toBeNull()
  })
})