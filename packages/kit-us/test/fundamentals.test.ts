import { describe, expect, it, vi } from 'vitest'
import {
  fetchUsFundamentals,
  renderUsFundamentals,
} from '../src/fundamentals.ts'
import { createGetFundamentalsTool } from '../src/index.ts'

describe('us_get_fundamentals', () => {
  it('fetches and renders US stock valuation and fundamental data from Yahoo Finance quote API', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/v7/finance/quote')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            quoteResponse: {
              result: [
                {
                  symbol: 'AAPL',
                  shortName: 'Apple Inc.',
                  fullExchangeName: 'NasdaqGS',
                  currency: 'USD',
                  marketCap: 3450000000000,
                  trailingPE: 33.5,
                  forwardPE: 28.2,
                  priceToBook: 48.6,
                  epsTrailingTwelveMonths: 6.85,
                  dividendYield: 0.0055,
                  fiftyTwoWeekHigh: 237.23,
                  fiftyTwoWeekLow: 164.08,
                  fiftyTwoWeekChangePercent: 0.284,
                  averageDailyVolume3Month: 48500000,
                  beta: 1.12,
                },
              ],
            },
          }),
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    const result = await fetchUsFundamentals({ symbol: 'AAPL', fetch: mockFetch as unknown as typeof globalThis.fetch })
    expect(result.data).toBeDefined()
    expect(result.data?.symbol).toBe('AAPL')
    expect(result.data?.name).toBe('Apple Inc.')
    expect(result.data?.marketCap).toBe(3450000000000)
    expect(result.data?.peTtm).toBe(33.5)
    expect(result.data?.peDynamic).toBe(28.2)
    expect(result.data?.pb).toBe(48.6)
    expect(result.data?.eps).toBe(6.85)
    expect(result.data?.dividendYield).toBe(0.0055)
    expect(result.beta).toBe(1.12)
    expect(result.avgVolume3Month).toBe(48500000)

    const rendered = renderUsFundamentals(result, 'AAPL')
    expect(rendered).toContain('us_get_fundamentals AAPL (Apple Inc.) [NasdaqGS]:')
    expect(rendered).toContain('Market Cap: $3,450,000,000,000 USD')
    expect(rendered).toContain('Trailing PE (TTM): 33.50')
    expect(rendered).toContain('Forward PE: 28.20')
    expect(rendered).toContain('Price to Book (PB): 48.60')
    expect(rendered).toContain('Diluted EPS (TTM): $6.85')
    expect(rendered).toContain('Dividend Yield: 0.55%')
    expect(rendered).toContain('Beta (5Y Monthly): 1.12')
    expect(rendered).toContain('52-Week Range: $164.08 - $237.23')
    expect(rendered).toContain('Avg Volume (3M): 48,500,000 shares')
  })

  it('handles empty results and network errors gracefully', async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'Server error' }) as Response)
    const tool = createGetFundamentalsTool({ fetch: mockFetch as unknown as typeof globalThis.fetch })
    const output = await tool.execute({ symbol: 'UNKNOWN' })
    expect(output).toContain('us_get_fundamentals UNKNOWN: no fundamental data available')
    expect(output).toContain('HTTP 500')
  })
})
