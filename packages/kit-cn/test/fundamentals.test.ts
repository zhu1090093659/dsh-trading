import { describe, expect, it, vi } from 'vitest'
import {
  fetchCnFundamentals,
  renderCnFundamentals,
  normalizeCnSymbol,
} from '../src/fundamentals.ts'
import { createGetFundamentalsTool } from '../src/index.ts'

describe('cn_get_fundamentals', () => {
  it('normalizes A-share symbols correctly', () => {
    expect(normalizeCnSymbol('600519')).toEqual({ wire: 'sh600519', canonical: '600519.SH' })
    expect(normalizeCnSymbol('600519.SH')).toEqual({ wire: 'sh600519', canonical: '600519.SH' })
    expect(normalizeCnSymbol('SH600519')).toEqual({ wire: 'sh600519', canonical: '600519.SH' })
    expect(normalizeCnSymbol('000001')).toEqual({ wire: 'sz000001', canonical: '000001.SZ' })
    expect(normalizeCnSymbol('000001.SZ')).toEqual({ wire: 'sz000001', canonical: '000001.SZ' })
    expect(normalizeCnSymbol('300750')).toEqual({ wire: 'sz300750', canonical: '300750.SZ' })
    expect(normalizeCnSymbol('688981')).toEqual({ wire: 'sh688981', canonical: '688981.SH' })
  })

  it('fetches and parses A-share fundamentals from Tencent quote mock data', async () => {
    // 腾讯接口真实返回 GBK 编码数据（"贵州茅台" GBK bytes: 0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8）
    const gbkName = new Uint8Array([0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8])
    const prefix = new TextEncoder().encode('v_sh600519="1~')
    const suffix = new TextEncoder().encode('~600519~1297.40~1292.30~1289.00~16126~8576~7550~1297.35~5~1297.20~1~1297.10~3~1297.01~3~1297.00~11~1297.40~9~1297.50~11~1297.55~2~1297.68~1~1297.70~1~~20260828161500~5.10~0.39~1297.89~1288.00~1297.40/16126/2086008422~16126~208601~0.13~19.92~~1297.89~1288.00~0.77~16218.56~16218.56~6.46~1421.53~1163.07~0.54~-1~1293.56~18.22~19.70~~~0.10~208600.8422~168.6620~13~   A~GP-A~-3.84~1.93~4.01~32.41~27.30~1539.98~1151.01~-3.32~-3.94~4.63~1250081601~1250081601~-2.13~-6.26~1250081601~~~-6.94~0.02~~CNY~0~___D__F__N~1296.83~14~";')
    const encoded = new Uint8Array(prefix.length + gbkName.length + suffix.length)
    encoded.set(prefix, 0)
    encoded.set(gbkName, prefix.length)
    encoded.set(suffix, prefix.length + gbkName.length)

    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => encoded.buffer,
    }) as unknown as Response)

    const result = await fetchCnFundamentals({ symbol: '600519.SH', fetch: mockFetch as unknown as typeof globalThis.fetch })
    expect(result.data).toBeDefined()
    expect(result.data?.symbol).toBe('600519.SH')
    expect(result.data?.name).toBe('贵州茅台')
    expect(result.data?.marketCap).toBe(1621856000000)
    expect(result.data?.floatMarketCap).toBe(1621856000000)
    expect(result.data?.pb).toBe(6.46)
    expect(result.data?.turnoverRate).toBe(0.13)
    expect(result.amplitudePercent).toBe(0.77)
    expect(result.limitUpPrice).toBe(1421.53)
    expect(result.limitDownPrice).toBe(1163.07)
    expect(result.data?.fiftyTwoWeekHigh).toBe(1539.98)
    expect(result.data?.fiftyTwoWeekLow).toBe(1151.01)

    const rendered = renderCnFundamentals(result, '600519.SH')
    expect(rendered).toContain('cn_get_fundamentals 600519.SH (贵州茅台):')
    expect(rendered).toContain('总市值: 16218.56 亿元 CNY')
    expect(rendered).toContain('流通市值: 16218.56 亿元 CNY')
    expect(rendered).toContain('市净率 (PB): 6.46')
    expect(rendered).toContain('换手率: 0.13%')
    expect(rendered).toContain('涨跌停区间: ¥1163.07 (跌停) ~ ¥1421.53 (涨停)')
    expect(rendered).toContain('52 周最高/最低: ¥1151.01 ~ ¥1539.98')
  })

  it('handles errors gracefully in execute', async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 500 } as unknown as Response))
    const tool = createGetFundamentalsTool({ fetch: mockFetch as unknown as typeof globalThis.fetch })
    const output = await tool.execute({ symbol: '600519' })
    expect(output).toContain('cn_get_fundamentals 600519: no fundamental data available')
  })
})
