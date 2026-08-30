/**
 * hk_get_news 取数层/工具单测（WS4 #1：#6 降级方案——东财快讯 HK 列按 116. 港股代码/关键词过滤）。
 * mock fetch，不触真实网络。覆盖：港股相关性过滤、symbol 过滤（00700）、时间窗、降级/fail-soft、工具壳渲染。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { aggregateNews, isHkRelevant, parseHkShowTime } from '../src/news.ts'
import { createGetNewsTool } from '../src/index.ts'

const NOW = Date.parse('2026-08-30T20:00:00Z')

type Resp = { ok: boolean; status: number; text: () => Promise<string> }
const jsonResp = (obj: unknown): Resp => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
const failResp = (status: number, body = 'boom'): Resp => ({ ok: false, status, text: async () => body })

const eastmoneyHkJson = {
  data: {
    fastNewsList: [
      { title: '腾讯控股回购股份', showTime: '2026-08-30 19:00:00', code: '202608300001', summary: 'x', stockList: ['116.00700'] },
      { title: '阿里健康发布中期业绩', showTime: '2026-08-30 18:00:00', code: '202608300002', summary: 'x', stockList: ['116.00241'] },
      { title: '贵州茅台发布半年度业绩', showTime: '2026-08-30 17:00:00', code: '202608300003', summary: 'x', stockList: ['1.600519'] },
      { title: '港交所拟优化上市制度', showTime: '2026-08-30 16:00:00', code: '202608300004', summary: 'x', stockList: [] },
    ],
  },
}

const mockFetch = (resp: Resp) => vi.fn(async () => resp) as unknown as typeof globalThis.fetch

afterEach(() => { vi.unstubAllGlobals() })

describe('isHkRelevant（港股相关性：116. 代码 或 港股关键词）', () => {
  it('命中 116. 前缀代码或港股关键词；A 股/无前缀代码不命中', () => {
    expect(isHkRelevant({ title: '腾讯控股回购', relatedCodes: ['116.00700'] })).toBe(true)
    expect(isHkRelevant({ title: '港交所优化制度', relatedCodes: [] })).toBe(true) // 关键词
    expect(isHkRelevant({ title: '贵州茅台', relatedCodes: ['1.600519'] })).toBe(false) // A 股
  })
})

describe('parseHkShowTime（东八区 → ISO 毫秒）', () => {
  it('解析无时区后缀 showTime', () => {
    expect(parseHkShowTime('2026-08-30 19:00:00')).toBe(Date.parse('2026-08-30T19:00:00+08:00'))
  })
})

describe('aggregateNews（东财 HK 列 + 港股过滤 + symbol + 降级）', () => {
  it('只保留港股相关项：116. 代码项（腾讯/阿里健康）+ 关键词项（港交所）；A 股项被滤', async () => {
    const { items, unavailable } = await aggregateNews({ fetch: mockFetch(jsonResp(eastmoneyHkJson)), now: NOW })
    expect(unavailable).toEqual([])
    const titles = items.map((i) => i.title)
    expect(titles).toContain('腾讯控股回购股份')
    expect(titles).toContain('阿里健康发布中期业绩')
    expect(titles).toContain('港交所拟优化上市制度')
    expect(titles).not.toContain('贵州茅台发布半年度业绩') // A 股 (1.) 被滤
  })

  it('symbol 过滤：00700（补零归一化）命中腾讯 116.00700；单源失败 fail-soft', async () => {
    const { items } = await aggregateNews({ fetch: mockFetch(jsonResp(eastmoneyHkJson)), now: NOW, symbol: '00700' })
    expect(items.map((i) => i.title)).toContain('腾讯控股回购股份')
    const failed = await aggregateNews({ fetch: mockFetch(failResp(500)), now: NOW })
    expect(failed.unavailable.some((u) => u.includes('eastmoney'))).toBe(true)
    expect(failed.items).toHaveLength(0)
  })
})

describe('createGetNewsTool（工具壳）', () => {
  it('execute 渲染：含 DEGRADED 标注、来源、链接', async () => {
    const base = Date.now() - 1_800_000
    const near = { data: { fastNewsList: [{ title: '腾讯控股回购', showTime: new Date(base).toISOString().slice(0, 19).replace('T', ' '), code: '202608300001', summary: 'x', stockList: ['116.00700'] }] } }
    vi.stubGlobal('fetch', mockFetch(jsonResp(near)))
    const tool = createGetNewsTool()
    expect(tool.name).toBe('hk_get_news')
    const text = await tool.execute({ windowHours: 24, limit: 10 }) as string
    expect(text).toContain('hk_get_news — ')
    expect(text).toContain('DEGRADED')
    expect(text).toContain('[eastmoney]')
    expect(text).toContain('https://finance.eastmoney.com/a/202608300001.html')
  })
})
