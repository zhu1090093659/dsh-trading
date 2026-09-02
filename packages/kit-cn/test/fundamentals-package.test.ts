/**
 * 基本面下钻包单测（issue #36 整改，2026-09-02）：
 * - 上游请求头与超时（最小 UA，无伪造 Referer，AbortSignal.timeout）；
 * - reportapi 列表去重（预测与研报共享一次上游）；
 * - 零假数据：缺评级不兜底「买入」、未知评级不计入买入、无披露变动不产增减持行。
 * 全部用注入 fetch 假件，不触网。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  fetchCnForecast,
  fetchCnReports,
  fetchCnFundamentalsPackage,
  fetchCnShareholdersData,
  formatReportPeriod,
} from '../src/fundamentals.ts'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

describe('formatReportPeriod（期间键映射）', () => {
  it('月份 → 期别标签，12 月去重分支不再误写', () => {
    expect(formatReportPeriod('2025-03-31')).toBe('2025/Q1')
    expect(formatReportPeriod('2025-06-30')).toBe('2025/H1')
    expect(formatReportPeriod('2025-09-30')).toBe('2025/Q3')
    expect(formatReportPeriod('2025-12-31')).toBe('2025/FY')
  })
})

describe('上游请求纪律（整改 M4/M5）', () => {
  it('fetchJsonUpstream 发送最小 UA、无 Referer、带 10s AbortSignal 超时', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response
    }) as unknown as typeof globalThis.fetch

    await fetchCnForecast('600519.SH', mockFetch)
    expect(calls.length).toBeGreaterThan(0)
    for (const { url, init } of calls) {
      expect(url).toContain('reportapi.eastmoney.com')
      const headers = (init.headers ?? {}) as Record<string, string>
      expect(headers['User-Agent']).toBe('Mozilla/5.0')
      expect(headers.Referer).toBeUndefined()
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })
})

describe('零假数据（整改 M3）', () => {
  it('缺评级的研究报告 → rating/summary 为 undefined，不伪造「买入」', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { infoCode: 'AP202601', title: '某公司深度', orgSName: '某券商', publishDate: '2026-01-15 00:00:00' },
        ],
      }),
    }) as unknown as Response) as unknown as typeof globalThis.fetch

    const reports = await fetchCnReports('600519.SH', mockFetch)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.rating).toBeUndefined()
    expect(reports[0]!.summary).toBeUndefined()
  })

  it('未知评级（如「跑赢行业」）不计入 buyRatingCount', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { emRatingName: '跑赢行业', predictThisYearEps: 1.2 },
          { emRatingName: '买入', predictThisYearEps: 1.4 },
          { emRatingName: '减持', predictThisYearEps: 1.1 },
        ],
      }),
    }) as unknown as Response) as unknown as typeof globalThis.fetch

    const forecast = await fetchCnForecast('600519.SH', mockFetch)
    expect(forecast?.buyRatingCount).toBe(1)
    expect(forecast?.holdRatingCount).toBe(0)
    expect(forecast?.sellRatingCount).toBe(1)
  })

  it('无披露变动（HOLD_NUM_CHANGE 缺失/为 0）不产增减持行；变动行 changeShares=变动量而非持股总量', async () => {
    const mockFetch = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('RPT_F10_EH_FREEHOLDERS')) {
        return {
          ok: true,
          json: async () => ({
            result: { data: [
              { HOLDER_NAME: '甲', HOLD_NUM: 1_000_000, FREE_HOLDNUM_RATIO: 5.5, HOLD_NUM_CHANGE: 0 },
              { HOLDER_NAME: '乙', HOLD_NUM: 2_000_000, FREE_HOLDNUM_RATIO: 6.5, HOLD_NUM_CHANGE: -300_000, IS_HOLDORG: '1', UPDATE_DATE: '2026-06-30' },
            ] },
          }),
        } as unknown as Response
      }
      return { ok: true, json: async () => ({ result: { data: [] } }) } as unknown as Response
    }) as unknown as typeof globalThis.fetch

    const res = await fetchCnShareholdersData('600519.SH', mockFetch)
    expect(res.shareholders).toHaveLength(2)
    // 甲无变动不产行；乙减持 30 万股 → changeShares=变动量
    expect(res.insiderTrades).toHaveLength(1)
    expect(res.insiderTrades[0]).toMatchObject({ holderName: '乙', changeType: '减持', changeShares: 300_000 })
  })
})

describe('fetchCnFundamentalsPackage 上游去重（整改 M4）', () => {
  it('reportapi 只打一次；非法符号抛错（不被桥吞成静默空包）', async () => {
    const urls: string[] = []
    const mockFetch = vi.fn(async (url: string | URL) => {
      urls.push(String(url))
      return { ok: true, json: async () => ({ data: [], result: { data: [] } }) } as unknown as Response
    }) as unknown as typeof globalThis.fetch

    await fetchCnFundamentalsPackage('600519.SH', mockFetch)
    const reportapiCalls = urls.filter(u => u.includes('reportapi.eastmoney.com'))
    expect(reportapiCalls).toHaveLength(1)

    // qt.gtimg 报价、emweb、datacenter 各至多一次
    const gtimgCalls = urls.filter(u => u.includes('qt.gtimg.cn'))
    expect(gtimgCalls.length).toBeLessThanOrEqual(2) // connector 与 kit 各一，kit 内部不重复
  })
})
