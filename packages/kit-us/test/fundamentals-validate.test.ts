/**
 * US symbol 校验与超时纪律单测（issue #36 整改 L1/M4）。
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchUsFundamentalsPackage, fetchUsFinancialMatrix } from '../src/fundamentals.ts'

describe('normalizeUsSymbol（L1 整改：US ticker 白名单）', () => {
  it('非法字符（路径注入/查询注入）被拒', async () => {
    const bad = ['AAPL?x=1', '../../etc', 'AA PL', 'A;ls', '']
    for (const sym of bad) {
      await expect(fetchUsFundamentalsPackage(sym, (() => Promise.resolve({ ok: false })) as unknown as typeof globalThis.fetch))
        .rejects.toThrow(/invalid US symbol/)
    }
  })

  it('合法 ticker（字母/点/横杠/^）通过且 URL path 被 encodeURIComponent', async () => {
    const urls: string[] = []
    const mockFetch = vi.fn(async (url: string | URL) => {
      urls.push(String(url))
      return { ok: false, status: 404 } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    await fetchUsFundamentalsPackage('BRK.B', mockFetch)
    expect(urls.some(u => u.includes('/v10/finance/quoteSummary/BRK.B'))).toBe(true)
    // 无裸插值：path 分段不包含未编码字符
    expect(urls.every(u => !u.includes('quoteSummary/AA'))).toBe(true)
  })

  it('quoteSummary 请求带 10s AbortSignal 超时', async () => {
    let captured: RequestInit | undefined
    const mockFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      captured = init
      return { ok: false, status: 404 } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    await fetchUsFinancialMatrix('AAPL', mockFetch)
    expect(captured?.signal).toBeInstanceOf(AbortSignal)
    expect((captured?.headers as Record<string, string>)['user-agent']).toBe('Mozilla/5.0')
  })
})
