import { describe, expect, it, vi } from 'vitest'
import {
  fetchCryptoDerivatives,
  renderDerivativesData,
  normalizeBinanceFuturesSymbol,
  extractBaseAsset,
} from '../src/derivatives.ts'
import { createGetDerivativesTool } from '../src/index.ts'

describe('crypto_get_derivatives', () => {
  it('normalizes symbols correctly', () => {
    expect(normalizeBinanceFuturesSymbol('BTCUSDT')).toBe('BTCUSDT')
    expect(normalizeBinanceFuturesSymbol('btcusdt')).toBe('BTCUSDT')
    expect(normalizeBinanceFuturesSymbol('BTCUSDT-SWAP')).toBe('BTCUSDT')
    expect(normalizeBinanceFuturesSymbol('BTC-USDT-SWAP')).toBe('BTCUSDT')
    expect(extractBaseAsset('BTCUSDT')).toBe('BTC')
    expect(extractBaseAsset('ETHUSDT-SWAP')).toBe('ETH')
    expect(extractBaseAsset('SOLUSDC')).toBe('SOL')
  })

  it('fetches and aggregates derivatives indicators from mock responses', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/fapi/v1/openInterest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ openInterest: '72540.123', symbol: 'BTCUSDT', time: 1772390400000 }),
        } as Response
      }
      if (url.includes('/futures/data/globalLongShortAccountRatio')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ longShortRatio: '1.85', longAccount: '0.65', shortAccount: '0.35', timestamp: 1772390400000 }],
        } as Response
      }
      if (url.includes('/futures/data/topLongShortPositionRatio')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ longShortRatio: '1.42', longPosition: '0.587', shortPosition: '0.413', timestamp: 1772390400000 }],
        } as Response
      }
      if (url.includes('/futures/data/takerlongshortRatio')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ buySellRatio: '1.15', buyVol: '1500.5', sellVol: '1304.7', timestamp: 1772390400000 }],
        } as Response
      }
      if (url.includes('/fapi/v1/fundingRate')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ symbol: 'BTCUSDT', fundingRate: '0.00010000', fundingTime: 1772390400000 }],
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    const result = await fetchCryptoDerivatives({ symbol: 'BTCUSDT-SWAP', fetch: mockFetch as unknown as typeof globalThis.fetch })
    expect(result.data).toBeDefined()
    expect(result.data?.symbol).toBe('BTCUSDT-SWAP')
    expect(result.data?.openInterest).toBe(72540.123)
    expect(result.data?.longShortRatio).toBe(1.85)
    expect(result.data?.topTraderLongShortRatio).toBe(1.42)
    expect(result.data?.takerBuySellRatio).toBe(1.15)
    expect(result.data?.fundingRate).toBe(0.0001)

    const rendered = renderDerivativesData(result, 'BTCUSDT-SWAP')
    expect(rendered).toContain('Open Interest (OI): 72,540.123')
    expect(rendered).toContain('Global Long/Short Account Ratio: 1.85')
    expect(rendered).toContain('Top Trader Position L/S Ratio: 1.42')
    expect(rendered).toContain('Taker Buy/Sell Volume Ratio: 1.15')
    expect(rendered).toContain('Latest Funding Rate: 0.0001 (0.0100%)')
  })

  it('tolerates partial failures and reports unavailable sub-queries', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/fapi/v1/openInterest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ openInterest: '50000', symbol: 'BTCUSDT', time: 1772390400000 }),
        } as Response
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response
    })

    const tool = createGetDerivativesTool({ fetch: mockFetch as unknown as typeof globalThis.fetch })
    const output = await tool.execute({ symbol: 'BTCUSDT' })
    expect(output).toContain('Open Interest (OI): 50,000')
    expect(output).toContain('partially unavailable sub-queries')
  })
})
