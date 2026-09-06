import { describe, expect, it } from 'vitest'
import { composeResearchSection, summarizeFundamentals, type ResearchCopy } from '../src/client/compose-research.ts'

const copy: ResearchCopy = { header: 'context', announcements: 'disclosures', news: 'news', fundamentals: 'fundamentals', unavailable: 'unavailable', empty: 'no items', sourcesUnavailable: 'failed sources', guidance: 'verify originals', omitted: 'summary budget exceeded' }

describe('research context', () => {
  it('separates announcements and news with provenance and partial failures', () => {
    const result = composeResearchSection({ capturedAt: '2026-09-06', news: { items: [
      { source: 'sec-edgar', title: '10-K', url: 'https://sec.gov/report', publishedAt: '2026-09-01' },
      { source: 'media', title: 'Company news', url: 'https://example.com/news', publishedAt: '2026-09-02' },
    ], unavailable: ['provider'] }, fundamentals: { market: 'us', symbol: 'AAPL', stock: { symbol: 'AAPL', peTtm: 30, timestamp: 123 }, profile: { symbol: 'AAPL', industry: 'Technology' } } }, copy)
    expect(result).toContain('disclosures\n- {"title":"10-K"')
    expect(result).toContain('news\n- {"title":"Company news"')
    expect(result).toContain('https://sec.gov/report')
    expect(result).toContain('failed sources: provider')
    expect(result).toContain('"peTtm":30')
    expect(result).toContain('Technology')
  })
  it('distinguishes failure from empty search and empty fundamental shells', () => {
    const failed = composeResearchSection({ capturedAt: 'now', news: null, fundamentals: undefined }, copy)
    expect(failed).toContain('news\nunavailable')
    const empty = composeResearchSection({ capturedAt: 'now', news: { items: [], unavailable: [] }, fundamentals: { market: 'us', symbol: 'AAPL' } }, copy)
    expect(empty).toContain('news\nno items')
    expect(empty).toContain('fundamentals\nunavailable')
  })
  it('bounds lists and financial periods while retaining units and zero values', () => {
    const summary = summarizeFundamentals({ market: 'cn', symbol: '600519', matrix: { currency: 'CNY', periods: ['2022', '2023', '2024', '2025'], groups: [{ id: 'profit', title: 'Profit', rows: [{ id: 'eps', name: 'EPS', unit: 'CNY', values: { '2022': { value: 1 }, '2025': { value: 0 } } }] }] } })
    const json = JSON.stringify(summary)
    expect(json).not.toContain('2022')
    expect(json).toContain('"value":0')
    expect(json).toContain('"unit":"CNY"')
    const result = composeResearchSection({ capturedAt: 'now', fundamentals: undefined, news: { unavailable: [], items: Array.from({ length: 30 }, (_, i) => ({ source: 'media', title: `item-${i}`, publishedAt: `2026-09-${String(i + 1).padStart(2, '0')}`, url: 'https://example.com' })) } }, copy)
    expect(result.match(/"title"/g)).toHaveLength(10)
  })
})
