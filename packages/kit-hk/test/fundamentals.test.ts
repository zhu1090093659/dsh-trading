import { describe, expect, it, vi } from 'vitest'
import {
  fetchHkFundamentals,
  renderHkFundamentals,
  normalizeHkSymbol,
} from '../src/fundamentals.ts'
import { createGetFundamentalsTool } from '../src/index.ts'

describe('hk_get_fundamentals', () => {
  it('normalizes HK stock codes correctly', () => {
    expect(normalizeHkSymbol('700')).toEqual({ code5: '00700', canonical: '00700.HK' })
    expect(normalizeHkSymbol('00700')).toEqual({ code5: '00700', canonical: '00700.HK' })
    expect(normalizeHkSymbol('00700.HK')).toEqual({ code5: '00700', canonical: '00700.HK' })
    expect(normalizeHkSymbol('9988')).toEqual({ code5: '09988', canonical: '09988.HK' })
  })

  it('fetches and parses HK stock fundamentals from Tencent quote mock data', async () => {
    // 腾讯接口真实返回 GBK 编码数据（"腾讯控股" GBK bytes: 0xcc, 0xda, 0xd1, 0xb6, 0xbf, 0xd8, 0xb9, 0xc9）
    const gbkName = new Uint8Array([0xcc, 0xda, 0xd1, 0xb6, 0xbf, 0xd8, 0xb9, 0xc9])
    const prefix = new TextEncoder().encode('v_r_hk00700="100~')
    const suffix = new TextEncoder().encode('~00700~455.200~447.800~444.000~27742475.0~0~0~455.200~0~0~0~0~0~0~0~0~0~455.200~0~0~0~0~0~0~0~0~0~27742475.0~2026/08/28 16:08:37~7.400~1.65~462.200~443.400~455.200~27742475.0~12655334445.330~0~16.65~~0~0~4.20~41437.5241~41437.5241~TENCENT~1.17~677.700~411.000~1.53~0.44~0~0~0~0~0~15.28~3.18~0.30~100~-23.33~-0.39~GP~20.41~11.00~3.45~-4.21~-2.40~9103146761.00~9103146761.00~15.77~5.309~456.172~-25.58~HKD~1~50";')
    const encoded = new Uint8Array(prefix.length + gbkName.length + suffix.length)
    encoded.set(prefix, 0)
    encoded.set(gbkName, prefix.length)
    encoded.set(suffix, prefix.length + gbkName.length)

    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => encoded.buffer,
    }) as unknown as Response)

    const result = await fetchHkFundamentals({ symbol: '00700.HK', fetch: mockFetch as unknown as typeof globalThis.fetch })
    expect(result.data).toBeDefined()
    expect(result.data?.symbol).toBe('00700.HK')
    expect(result.data?.name).toBe('腾讯控股')
    expect(result.nameEn).toBe('TENCENT')
    expect(result.data?.marketCap).toBe(4143752410000)
    expect(result.data?.peTtm).toBe(15.28)
    expect(result.data?.peDynamic).toBe(16.65)
    expect(result.data?.pb).toBe(3.18)
    expect(result.data?.dividendYield).toBeCloseTo(0.0117)
    expect(result.data?.turnoverRate).toBe(0.30)
    expect(result.amplitudePercent).toBe(4.20)
    expect(result.data?.fiftyTwoWeekHigh).toBe(677.7)
    expect(result.data?.fiftyTwoWeekLow).toBe(411.0)

    const rendered = renderHkFundamentals(result, '00700.HK')
    expect(rendered).toContain('hk_get_fundamentals 00700.HK (腾讯控股) [TENCENT]:')
    expect(rendered).toContain('总市值: 41437.52 亿港元 (HKD)')
    expect(rendered).toContain('滚动市盈率 (PE TTM): 15.28')
    expect(rendered).toContain('市净率 (PB): 3.18')
    expect(rendered).toContain('股息率 (Dividend Yield): 1.17%')
    expect(rendered).toContain('换手率: 0.30%')
    expect(rendered).toContain('52 周最高/最低: HK$411.000 ~ HK$677.700')
  })

  it('handles errors gracefully in execute', async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 500 } as unknown as Response))
    const tool = createGetFundamentalsTool({ fetch: mockFetch as unknown as typeof globalThis.fetch })
    const output = await tool.execute({ symbol: '700' })
    expect(output).toContain('hk_get_fundamentals 700: no fundamental data available')
  })
})
