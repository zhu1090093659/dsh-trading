import { describe, expect, it, vi } from 'vitest'
import {
  fetchCryptoFundamentals,
  renderCryptoFundamentals,
} from '../src/fundamentals.ts'
import { createGetFundamentalsTool } from '../src/index.ts'

describe('crypto_get_fundamentals', () => {
  it('fetches and renders crypto tokenomics data from CoinCap and Binance', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/assets/bitcoin')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              id: 'bitcoin',
              rank: '1',
              symbol: 'BTC',
              name: 'Bitcoin',
              supply: '19750000',
              maxSupply: '21000000',
              marketCapUsd: '1350000000000',
              volumeUsd24Hr: '35000000000',
              priceUsd: '68500',
              changePercent24Hr: '2.5',
            },
          }),
        } as Response
      }
      if (url.includes('/api/v3/ticker/24hr')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            quoteVolume: '1500000000',
            priceChangePercent: '2.48',
            count: 2450000,
          }),
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    const result = await fetchCryptoFundamentals({ symbol: 'BTCUSDT', fetch: mockFetch as unknown as typeof globalThis.fetch })
    expect(result.data).toBeDefined()
    expect(result.data?.rank).toBe(1)
    expect(result.data?.name).toBe('Bitcoin')
    expect(result.data?.marketCapUsd).toBe(1350000000000)
    expect(result.data?.circulatingSupply).toBe(19750000)
    expect(result.data?.totalSupply).toBe(21000000)
    expect(result.quoteVolume24h).toBe(1500000000)
    expect(result.priceChangePercent24h).toBe(2.48)
    expect(result.tradesCount24h).toBe(2450000)

    const rendered = renderCryptoFundamentals(result, 'BTCUSDT')
    expect(rendered).toContain('Global Market Cap Rank: #1')
    expect(rendered).toContain('Market Cap: $1,350,000,000,000 USD')
    expect(rendered).toContain('Circulating Supply: 19,750,000 coins')
    expect(rendered).toContain('24h Price Change: +2.48%')
    expect(rendered).toContain('24h Trades Count (Binance Spot): 2,450,000 trades')
  })

  it('tolerates CoinCap outage and falls back to Binance 24hr ticker gracefully', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('coincap.io')) {
        return { ok: false, status: 500 } as Response
      }
      if (url.includes('/api/v3/ticker/24hr')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            quoteVolume: '500000000',
            priceChangePercent: '-1.25',
            count: 850000,
          }),
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    const tool = createGetFundamentalsTool({ fetch: mockFetch as unknown as typeof globalThis.fetch })
    const output = await tool.execute({ symbol: 'ETHUSDT' })
    expect(output).toContain('crypto_get_fundamentals ETHUSDT')
    expect(output).toContain('24h Price Change: -1.25%')
    expect(output).toContain('partially unavailable sources')
  })
})
