/**
 * cn_get_news 取数层/工具单测（WS4 #1：#6；spike EVIDENCE 推荐东财快讯）。
 * mock fetch，不触真实网络。覆盖：东财解析（showTime 东八区 → ISO、url 由 code 构造）、
 * 聚合/过滤/容错、工具壳渲染。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { aggregateNews, parseCnShowTime } from '../src/news.ts'
import { createGetNewsTool } from '../src/index.ts'

const NOW = Date.parse('2026-08-30T20:00:00Z')

type Resp = { ok: boolean; status: number; text: () => Promise<string> }
const jsonResp = (obj: unknown): Resp => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
const failResp = (status: number, body = 'boom'): Resp => ({ ok: false, status, text: async () => body })

const eastmoneyJson = {
  data: {
    fastNewsList: [
      { title: '贵州茅台发布半年度业绩', showTime: '2026-08-30 19:00:00', code: '202608300001', summary: '【正文】...', stockList: ['1.600519'] },
      { title: '沪指收盘涨0.5%', showTime: '2026-08-29 15:00:00', code: '202608290002', summary: '【正文】...' },
    ],
  },
}

function mockFetch(resp: Resp) {
  return vi.fn(async () => resp) as unknown as typeof globalThis.fetch
}

afterEach(() => { vi.unstubAllGlobals() })

describe('parseCnShowTime（东财时间 → 东八区 ISO 毫秒）', () => {
  it('解析东八区无时区后缀的 showTime', () => {
    const ts = parseCnShowTime('2026-08-30 19:00:00')
    expect(ts).toBe(Date.parse('2026-08-30T19:00:00+08:00'))
    expect(Number.isNaN(parseCnShowTime('bad'))).toBe(true)
  })
})

describe('aggregateNews（东财单源聚合 + 过滤）', () => {
  it('解析列表：url 由 code 构造、source=eastmoney、时间过滤 24h 窗、不引 summary', async () => {
    const { items, unavailable } = await aggregateNews({ fetch: mockFetch(jsonResp(eastmoneyJson)), now: NOW })
    expect(unavailable).toEqual([])
    const first = items.find((i) => i.title.includes('贵州茅台'))
    expect(first?.source).toBe('eastmoney')
    expect(first?.url).toBe('https://finance.eastmoney.com/a/202608300001.html')
    expect(first?.publishedAt).toBe(new Date(Date.parse('2026-08-30T19:00:00+08:00')).toISOString())
    // 29 日 15:00（东八区）相对 now(2026-08-30T20:00Z=08-31 04:00 北京) 超窗被滤
    expect(items.some((i) => i.title.includes('沪指'))).toBe(false)
  })

  it('东财请求必带 sortEnd 与 req_trace=1（缺一该端点返 data:null 致整源失败）', async () => {
    let url = ''
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      url = String(input)
      return jsonResp(eastmoneyJson)
    }) as unknown as typeof globalThis.fetch
    await aggregateNews({ fetch: fetchImpl, now: NOW })
    expect(url).toContain('sortEnd=')
    expect(url).toContain('req_trace=1')
  })

  it('symbol 过滤：600519 命中（含 .SH 归一化）；单源失败 fail-soft', async () => {
    const fetchImpl = mockFetch(jsonResp(eastmoneyJson))
    const withSymbol = await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '600519.SH' })
    expect(withSymbol.items.some((i) => i.title.includes('贵州茅台'))).toBe(true)
    const failFetch = mockFetch(failResp(500))
    const failed = await aggregateNews({ fetch: failFetch, now: NOW })
    expect(failed.unavailable.some((u) => u.includes('eastmoney'))).toBe(true)
    expect(failed.items).toHaveLength(0)
  })
})

describe('createGetNewsTool（工具壳）', () => {
  it('execute 渲染：含来源、时间、链接与 unavailable 注记', async () => {
    const base = Date.now() - 1_800_000
    const near = { data: { fastNewsList: [{ title: '贵州茅台涨停', showTime: new Date(base).toISOString().slice(0, 19).replace('T', ' '), code: '202608300001', summary: 'x' }] } }
    vi.stubGlobal('fetch', mockFetch(jsonResp(near)))
    const tool = createGetNewsTool()
    expect(tool.name).toBe('cn_get_news')
    const text = await tool.execute({ windowHours: 24, limit: 10 }) as string
    expect(text).toContain('cn_get_news — ')
    expect(text).toContain('[eastmoney]')
    expect(text).toContain('https://finance.eastmoney.com/a/202608300001.html')
  })
})

describe('fetchEastmoneyAnnouncements（公告源，评审 M4/M5/M6 整改）', () => {
  const annJson = {
    data: {
      list: [
        { art_code: 'A1', title: '贵州茅台关于回购股份的公告', display_time: '2026-08-25 09:00:00' },
        { art_code: 'A2', title: '坏时间条目', display_time: 'not-a-time' },
      ],
    },
  }

  it('公告走 7 天放宽窗：窗口外但 7 天内的公告保留；解析失败条目丢弃而非回退「现在」', async () => {
    const { items, unavailable } = await aggregateNews({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        return String(input).includes('np-anotice') ? jsonResp(annJson) : jsonResp({ data: { fastNewsList: [] } })
      }) as unknown as typeof globalThis.fetch,
      now: NOW,
      symbol: '600519',
    })
    expect(unavailable).toEqual([])
    // NOW = 08-30 20:00Z，公告 08-25 09:00(东八区)=08-25 01:00Z → 5.8 天前，在 7 天窗内
    const ann = items.find((i) => i.source === 'eastmoney-announcement')
    expect(ann?.title).toContain('回购股份')
    expect(ann?.publishedAt).toBe(new Date(Date.parse('2026-08-25T09:00:00+08:00')).toISOString())
    // 时间解析失败的条目被丢弃，不得回退 now()（虚假新鲜事件会恒过窗并钉最新 K 线）
    expect(items.some((i) => i.title === '坏时间条目')).toBe(false)
  })

  it('公告接口非 2xx → throw 进 unavailable，不再静默空数组', async () => {
    const { unavailable, items } = await aggregateNews({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        return url.includes('np-anotice') ? failResp(503) : jsonResp(eastmoneyJson)
      }) as unknown as typeof globalThis.fetch,
      now: NOW,
      symbol: '600519',
    })
    expect(unavailable.some((u) => u.includes('eastmoney-announcement'))).toBe(true)
    expect(items.every((i) => i.source !== 'eastmoney-announcement')).toBe(true)
  })

  it('公告 fetch 必带 10s AbortSignal（replication.md §9）', async () => {
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal | undefined
      return jsonResp(annJson)
    }) as unknown as typeof globalThis.fetch
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '600519' })
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})
