/**
 * cn_get_news 取数层/工具单测（WS4 #1：#6；spike EVIDENCE 推荐东财快讯）。
 * mock fetch，不触真实网络。覆盖：东财解析（showTime 东八区 → ISO、url 由 code 构造）、
 * 聚合/过滤/容错、工具壳渲染、巨潮公告源（orgId 中转、沪深分列、跨源去重）。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { aggregateNews, parseCnShowTime, resetCninfoAnnouncementMemo } from '../src/news.ts'
import { createGetNewsTool } from '../src/index.ts'

const NOW = Date.parse('2026-08-30T20:00:00Z')

type Resp = { ok: boolean; status: number; text: () => Promise<string> }
const jsonResp = (obj: unknown): Resp => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
const failResp = (status: number, body = 'boom'): Resp => ({ ok: false, status, text: async () => body })

/** URL 分发 mock：东财快讯 / 东财公告 / 巨潮 topSearch / 巨潮 hisAnnouncement 四路。 */
function cnRouteFetch(map: { emNews?: Resp; emAnn?: Resp; topSearch?: Resp; cninfo?: Resp } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('np-anotice')) return map.emAnn ?? jsonResp({ data: { list: [] } })
    if (url.includes('topSearch')) return map.topSearch ?? jsonResp({ keyBoardList: [{ code: '600519', orgId: 'gssh0600519', zwjc: '贵州茅台' }] })
    if (url.includes('hisAnnouncement')) return map.cninfo ?? jsonResp({ announcements: [] })
    return map.emNews ?? jsonResp({ data: { fastNewsList: [] } })
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => { resetCninfoAnnouncementMemo() })
afterEach(() => { vi.unstubAllGlobals() })

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
        { art_code: 'A1', title: '贵州茅台:关于回购股份的公告', display_time: '2026-08-25 09:00:00' },
        { art_code: 'A2', title: '坏时间条目', display_time: 'not-a-time' },
      ],
    },
  }

  it('公告走 7 天放宽窗：窗口外但 7 天内的公告保留；解析失败条目丢弃而非回退「现在」', async () => {
    const { items, unavailable } = await aggregateNews({
      fetch: cnRouteFetch({ emAnn: jsonResp(annJson) }),
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
      fetch: cnRouteFetch({ emAnn: failResp(503) }),
      now: NOW,
      symbol: '600519',
    })
    expect(unavailable.some((u) => u.includes('eastmoney-announcement'))).toBe(true)
    expect(items.every((i) => i.source !== 'eastmoney-announcement')).toBe(true)
  })

  it('公告 fetch 必带 10s AbortSignal（replication.md §9）', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal | undefined)
      if (String(_input).includes('np-anotice')) return jsonResp(annJson)
      if (String(_input).includes('topSearch')) return jsonResp({ keyBoardList: [{ code: '600519', orgId: 'gssh0600519' }] })
      if (String(_input).includes('hisAnnouncement')) return jsonResp({ announcements: [] })
      return jsonResp({ data: { fastNewsList: [] } })
    }) as unknown as typeof globalThis.fetch
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '600519' })
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true)
  })
})

describe('fetchCninfoAnnouncements（巨潮公告源，2026-09-03 多供应商冗余）', () => {
  // 东财公告主源夹具（公司名前缀 + 秒级 display_time 是真实格式）
  const emAnnFix = {
    data: {
      list: [
        { art_code: 'A1', title: '贵州茅台:关于回购股份的公告', display_time: '2026-08-25 09:00:00' },
      ],
    },
  }
  const cninfoAnn = {
    announcements: [
      // 与东财公告同一条披露（巨潮标题无公司前缀、日精度时间）→ 应被跨源去重丢弃
      { secCode: '600519', announcementTitle: '关于回购股份的公告', announcementTime: Date.parse('2026-08-25T00:00:00+08:00'), adjunctUrl: 'finalpage/2026-08-25/123.PDF' },
      // 东财没有的独立披露 → 保留（2026-08-24 在 NOW 前 6.8 天，7 天窗内）
      { secCode: '600519', announcementTitle: '2026年半年度报告', announcementTime: Date.parse('2026-08-25T00:00:00+08:00'), adjunctUrl: 'finalpage/2026-08-25/456.PDF' },
      // 缺 adjunctUrl / 坏时间戳 → 丢弃
      { secCode: '600519', announcementTitle: '无链接条目', announcementTime: Date.parse('2026-08-20T00:00:00+08:00') },
      { secCode: '600519', announcementTitle: '坏时间条目', announcementTime: 'not-a-number', adjunctUrl: 'finalpage/x.PDF' },
    ],
  }

  it('双源聚合：巨潮独立披露保留（URL 拼 static 域名）；与东财同日同类别去重；缺链接/坏时间丢弃', async () => {
    const { items, unavailable } = await aggregateNews({
      fetch: cnRouteFetch({ emAnn: jsonResp(emAnnFix), cninfo: jsonResp(cninfoAnn) }),
      now: NOW,
      symbol: '600519',
    })
    expect(unavailable).toEqual([])
    // 去重：回购公告只留东财主源（秒级时间）
    const buyback = items.filter((i) => i.title.includes('回购股份'))
    expect(buyback).toHaveLength(1)
    expect(buyback[0]?.source).toBe('eastmoney-announcement')
    // 独立披露保留
    const report = items.find((i) => i.source === 'cninfo-announcement')
    expect(report?.title).toBe('2026年半年度报告')
    expect(report?.url).toBe('https://static.cninfo.com.cn/finalpage/2026-08-25/456.PDF')
    expect(report?.publishedAt).toBe(new Date(Date.parse('2026-08-25T00:00:00+08:00')).toISOString())
    expect(items.some((i) => i.title === '无链接条目' || i.title === '坏时间条目')).toBe(false)
  })

  it('沪深分列：600519（沪）→ column=sse；002714（深）→ column=szse；orgId memo 二次调用不再请求 topSearch', async () => {
    const calls: string[] = []
    const bodies: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('hisAnnouncement')) bodies.push(String(init?.body))
      if (url.includes('topSearch')) return jsonResp({ keyBoardList: [{ code: '600519', orgId: 'gssh0600519' }, { code: '002714', orgId: '9900022995' }] })
      if (url.includes('hisAnnouncement')) return jsonResp({ announcements: [] })
      return jsonResp({ data: { list: [] } })
    }) as unknown as typeof globalThis.fetch
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '600519' })
    expect(bodies.at(-1)).toContain('column=sse')
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '002714' })
    expect(bodies.at(-1)).toContain('column=szse')
    expect(decodeURIComponent(bodies.at(-1)!)).toContain('stock=002714,9900022995')
    // 002714 是新标的 → 触发一次 topSearch；600519 已 memo → 仍只有 1 次 topSearch
    expect(calls.filter((u) => u.includes('topSearch'))).toHaveLength(2)
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '600519' })
    expect(calls.filter((u) => u.includes('topSearch'))).toHaveLength(2)
  })

  it('巨潮非 2xx → unavailable 注明 cninfo-announcement，东财公告不受影响（fail-soft）', async () => {
    const { unavailable, items } = await aggregateNews({
      fetch: cnRouteFetch({ emAnn: jsonResp(emAnnFix), cninfo: failResp(503) }),
      now: NOW,
      symbol: '600519',
    })
    expect(unavailable.some((u) => u.includes('cninfo-announcement'))).toBe(true)
    expect(items.some((i) => i.source === 'eastmoney-announcement')).toBe(true)
  })

  it('>24h 时间差或同源同名 → 不去重（同日两份同名披露是合法的不同文件）', async () => {
    const cninfoFar = {
      announcements: [
        // 与东财回购公告同名但相差 ~39h（>24h 容差、仍在 7 天窗内）→ 跨源不去重（进展类披露可同名多发）
        { secCode: '600519', announcementTitle: '关于回购股份的公告', announcementTime: Date.parse('2026-08-27T00:00:00+08:00'), adjunctUrl: 'finalpage/2026-08-27/789.PDF' },
      ],
    }
    const { items } = await aggregateNews({
      fetch: cnRouteFetch({ emAnn: jsonResp(emAnnFix), cninfo: jsonResp(cninfoFar) }),
      now: NOW,
      symbol: '600519',
    })
    expect(items.filter((i) => i.title.includes('回购'))).toHaveLength(2)
  })
})
