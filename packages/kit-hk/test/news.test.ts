/**
 * hk_get_news 取数层/工具单测（WS4 #1：#6 降级方案——东财快讯 HK 列按 116. 港股代码/关键词过滤）。
 * mock fetch，不触真实网络。覆盖：港股相关性过滤、symbol 过滤（00700）、时间窗、降级/fail-soft、
 * 工具壳渲染、HKEX 披露易公告源（stockId JSONP 剥壳、DATE_TIME 日月倒序、跨源去重）。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { aggregateNews, isHkRelevant, parseHkShowTime, parseHkexDateTime, resetHkexAnnouncementMemo } from '../src/news.ts'
import { createGetNewsTool } from '../src/index.ts'

const NOW = Date.parse('2026-08-30T20:00:00Z')

type Resp = { ok: boolean; status: number; text: () => Promise<string> }
const jsonResp = (obj: unknown): Resp => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
const textResp = (body: string): Resp => ({ ok: true, status: 200, text: async () => body })
const failResp = (status: number, body = 'boom'): Resp => ({ ok: false, status, text: async () => body })

/** URL 分发 mock：东财快讯 / 东财公告 / HKEX prefix.do / HKEX titleSearchServlet 四路。 */
function hkRouteFetch(map: { emNews?: Resp; emAnn?: Resp; prefix?: Resp; search?: Resp } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('np-anotice')) return map.emAnn ?? jsonResp({ data: { list: [] } })
    if (url.includes('prefix.do')) return map.prefix ?? textResp('callback({"stockInfo":[{"stockId":7609,"code":"00700","name":"騰訊控股"}]});')
    if (url.includes('titleSearchServlet')) return map.search ?? textResp('{"result":"[]"}')
    return map.emNews ?? jsonResp({ data: { fastNewsList: [] } })
  }) as unknown as typeof globalThis.fetch
}

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

beforeEach(() => { resetHkexAnnouncementMemo() })
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

describe('fetchEastmoneyHkAnnouncements（港股公告源，评审 M5/M6 整改）', () => {
  const annJson = {
    data: {
      list: [
        { art_code: 'H1', title: '腾讯控股截至2026年6月30日止中期业绩公告', display_time: '2026-08-26 09:00:00' },
        { art_code: 'H2', title: '坏时间条目', display_time: 'not-a-time' },
      ],
    },
  }

  it('7 天窗豁免生效：窗口外但 7 天内的公告保留；解析失败条目丢弃而非回退「现在」', async () => {
    const { items, unavailable } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: jsonResp(annJson) }),
      now: NOW,
      symbol: '00700',
    })
    expect(unavailable).toEqual([])
    const ann = items.find((i) => i.source === 'eastmoney-announcement')
    expect(ann?.title).toContain('中期业绩')
    expect(ann?.publishedAt).toBe(new Date(Date.parse('2026-08-26T09:00:00+08:00')).toISOString())
    expect(items.some((i) => i.title === '坏时间条目')).toBe(false)
  })

  it('公告接口非 2xx → throw 进 unavailable（不再静默空数组）', async () => {
    const { unavailable, items } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: failResp(500) }),
      now: NOW,
      symbol: '00700',
    })
    expect(unavailable.some((u) => u.includes('eastmoney-announcement'))).toBe(true)
    expect(items.every((i) => i.source !== 'eastmoney-announcement')).toBe(true)
  })

  it('公告 fetch 必带 10s AbortSignal（replication.md §9）', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal | undefined)
      return jsonResp({ data: { list: [] } })
    }) as unknown as typeof globalThis.fetch
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '00700' })
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true)
  })
})

describe('fetchHkexAnnouncements（HKEX 披露易公告源，2026-09-03 多供应商冗余）', () => {
  const hkexSearch = {
    result: JSON.stringify([
      // 与东财公告同一条披露（繁体、类别前缀相同）→ 应被跨源去重丢弃
      { TITLE: '翌日披露報表 - 已發行股份變動及股份購回', DATE_TIME: '26/08/2026 18:02', FILE_LINK: '/listedco/listconews/sehk/2026/0826/a.pdf', STOCK_CODE: '00700' },
      // 东财没有的独立披露 → 保留
      { TITLE: '刊發2026年中期報告', DATE_TIME: '25/08/2026 16:30', FILE_LINK: '/listedco/listconews/sehk/2026/0825/b.pdf', STOCK_CODE: '00700' },
      // 时间解析失败 → 丢弃
      { TITLE: '壞時間條目', DATE_TIME: 'not-a-date', FILE_LINK: '/x.pdf' },
    ]),
  }
  const emAnnSameDisclosure = {
    data: {
      list: [
        // display_time 与 HKEX DATE_TIME 同日（±24h 容差内）；繁简+括注差异靠归一化前缀 ≥6 字兜住
        { art_code: 'H1', title: '腾讯控股:翌日披露报表 - [其他 / 股份购回]', display_time: '2026-08-26 18:30:00' },
      ],
    },
  }

  it('parseHkexDateTime：DD/MM/YYYY HH:MM（日月倒序、东八区）；非法输入 NaN', () => {
    expect(parseHkexDateTime('02/09/2026 18:02')).toBe(Date.parse('2026-09-02T18:02:00+08:00'))
    expect(Number.isNaN(parseHkexDateTime('2026-09-02 18:02'))).toBe(true)
  })

  it('双源聚合：HKEX 独立披露保留；与东财同日同类别披露去重；坏时间条目丢弃', async () => {
    const { items, unavailable } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: jsonResp(emAnnSameDisclosure), search: textResp(JSON.stringify(hkexSearch)) }),
      now: NOW,
      symbol: '00700',
    })
    expect(unavailable).toEqual([])
    // 去重：翌日披露报表只留东财主源（秒级时间），HKEX 重复条目被丢弃
    const sameCategory = items.filter((i) => i.title.includes('翌日披露'))
    expect(sameCategory).toHaveLength(1)
    expect(sameCategory[0]?.source).toBe('eastmoney-announcement')
    // 独立披露保留：繁体标题、URL 拼接 HKEX 域名
    const hkexOnly = items.find((i) => i.source === 'hkex-announcement')
    expect(hkexOnly?.title).toBe('刊發2026年中期報告')
    expect(hkexOnly?.url).toBe('https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0825/b.pdf')
    expect(hkexOnly?.publishedAt).toBe(new Date(Date.parse('2026-08-25T16:30:00+08:00')).toISOString())
    expect(items.some((i) => i.title === '壞時間條目')).toBe(false)
  })

  it('stockId memo：同标的二次调用不再请求 prefix.do；prefix.do 失败 → unavailable 注明，东财公告不受影响', async () => {
    const fetchImpl = hkRouteFetch({ emAnn: jsonResp(emAnnSameDisclosure), search: textResp(JSON.stringify(hkexSearch)) })
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '00700' })
    const firstCalls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('prefix.do'))
    expect(firstCalls).toHaveLength(1)
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '00700' })
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('prefix.do'))).toHaveLength(1)

    const failFetch = hkRouteFetch({ emAnn: jsonResp(emAnnSameDisclosure), prefix: failResp(503) })
    resetHkexAnnouncementMemo()
    const { unavailable, items } = await aggregateNews({ fetch: failFetch, now: NOW, symbol: '00700' })
    expect(unavailable.some((u) => u.includes('hkex'))).toBe(true)
    expect(items.some((i) => i.source === 'eastmoney-announcement')).toBe(true)
  })

  it('HKEX 请求必带 fromDate/toDate 窗口参数与 rowRange', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      if (String(input).includes('titleSearchServlet')) return textResp('{"result":"[]"}')
      if (String(input).includes('prefix.do')) return textResp('callback({"stockInfo":[{"stockId":7609,"code":"00700"}]});')
      return jsonResp({ data: { list: [] } })
    }) as unknown as typeof globalThis.fetch
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '00700', limit: 20 })
    const searchUrl = urls.find((u) => u.includes('titleSearchServlet'))
    expect(searchUrl).toContain('stockId=7609')
    expect(searchUrl).toContain('fromDate=')
    expect(searchUrl).toContain('toDate=')
    expect(searchUrl).toContain('rowRange=20')
    expect(searchUrl).toContain('market=SEHK')
    // 评审 M3：NOW = 08-30 20:00Z = 港图 08-31 04:00 → toDate 必须是 20260831（UTC 日期 0830 会漏掉 08-31 当日披露）
    expect(searchUrl).toContain('toDate=20260831')
    expect(searchUrl).toContain('fromDate=20260528')
  })

  // 2026-09-03 评审 M1 负例（真实证据 hkex-titlesearch-00700.body：腾讯同日既有裸「翌日披露報表」
  // 也有「翌日披露報表 - 已發行股份變動及股份購回」，是两份不同文件）
  it('评审 M1 负例：裸类别短标题「翌日披露报表」（恰 6 字）与长标题同日跨源不判重', async () => {
    const emBare = { data: { list: [{ art_code: 'H2', title: '腾讯控股:翌日披露报表', display_time: '2026-08-26 18:00:00' }] } }
    const hkexFull = {
      result: JSON.stringify([
        { TITLE: '翌日披露報表 - 已發行股份變動及股份購回', DATE_TIME: '26/08/2026 18:02', FILE_LINK: '/listedco/listconews/sehk/2026/0826/a.pdf', STOCK_CODE: '00700' },
      ]),
    }
    const { items } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: jsonResp(emBare), search: textResp(JSON.stringify(hkexFull)) }),
      now: NOW,
      symbol: '00700',
    })
    expect(items.filter((i) => i.title.includes('翌日披露'))).toHaveLength(2)
  })

  it('评审 M1 负例：同族不同文件「已发行股份变动」vs「变动及股份购回」同日跨源不判重', async () => {
    const emVariant = { data: { list: [{ art_code: 'H3', title: '腾讯控股:翌日披露报表 - [其他]', display_time: '2026-08-26 18:00:00' }] } }
    const hkexVariant = {
      result: JSON.stringify([
        { TITLE: '翌日披露報表 - 已發行股份變動及股份購回', DATE_TIME: '26/08/2026 18:02', FILE_LINK: '/listedco/listconews/sehk/2026/0826/a.pdf', STOCK_CODE: '00700' },
      ]),
    }
    const { items } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: jsonResp(emVariant), search: textResp(JSON.stringify(hkexVariant)) }),
      now: NOW,
      symbol: '00700',
    })
    expect(items.filter((i) => i.title.includes('翌日披露'))).toHaveLength(2)
  })

  it('评审 M2：prefix.do 无精确 code 命中 → throw 进 unavailable，不用首条兜底', async () => {
    const prefix = textResp('callback({"stockInfo":[{"stockId":1,"code":"09999","name":"其他公司"}]});')
    const { unavailable, items } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: jsonResp(emAnnSameDisclosure), prefix }),
      now: NOW,
      symbol: '00700',
    })
    expect(unavailable.some((u) => u.includes('hkex'))).toBe(true)
    expect(items.every((i) => i.source !== 'hkex-announcement')).toBe(true)
  })

  it('评审 M2 第二道守卫：HKEX 条目 STOCK_CODE 与请求代码不符 → 丢弃', async () => {
    const wrongCompany = { result: JSON.stringify([{ TITLE: '其他公司披露', DATE_TIME: '26/08/2026 18:02', FILE_LINK: '/x.pdf', STOCK_CODE: '09999' }]) }
    const { items } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: jsonResp(emAnnSameDisclosure), search: textResp(JSON.stringify(wrongCompany)) }),
      now: NOW,
      symbol: '00700',
    })
    expect(items.every((i) => i.source !== 'hkex-announcement')).toBe(true)
  })

  it('评审 M2 第二道守卫放行：STOCK_CODE 含多个代码（`00700<br/>80700`）→ 00700 开头即保留', async () => {
    const multiCode = { result: JSON.stringify([{ TITLE: '翌日披露報表', DATE_TIME: '26/08/2026 18:02', FILE_LINK: '/y.pdf', STOCK_CODE: '00700<br/>80700' }]) }
    const { items } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: jsonResp({ data: { list: [] } }), search: textResp(JSON.stringify(multiCode)) }),
      now: NOW,
      symbol: '00700',
    })
    expect(items.filter((i) => i.source === 'hkex-announcement')).toHaveLength(1)
  })

  it('评审 L1：stockId lookup 失败后负缓存——TTL 内重试不再发 prefix.do 请求', async () => {
    let prefixCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('prefix.do')) { prefixCalls++; return failResp(503) }
      return jsonResp({ data: { list: [] } })
    }) as unknown as typeof globalThis.fetch
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '00700' })
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '00700' })
    expect(prefixCalls).toBe(1)
  })

  it('评审 L1：并发首次轮询同标的 → in-flight 合并，prefix.do 只发一次', async () => {
    let prefixCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('prefix.do')) {
        prefixCalls++
        await new Promise((r) => setTimeout(r, 10))
        return textResp('callback({"stockInfo":[{"stockId":7609,"code":"00700","name":"騰訊控股"}]});')
      }
      if (url.includes('titleSearchServlet')) return textResp('{"result":"[]"}')
      return jsonResp({ data: { list: [] } })
    }) as unknown as typeof globalThis.fetch
    const [a, b] = await Promise.all([
      aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '00700' }),
      aggregateNews({ fetch: fetchImpl, now: NOW, symbol: '00700' }),
    ])
    expect(prefixCalls).toBe(1)
    expect(a.items).toEqual(b.items)
  })

  it('评审 L2：HKEX 200 坏 JSON / 坏嵌套 result → unavailable 带 hkex-announcement 前缀', async () => {
    const badBody: Resp = { ok: true, status: 200, text: async () => '<html>not json</html>' }
    const { unavailable: u1 } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: jsonResp(emAnnSameDisclosure), search: badBody }),
      now: NOW,
      symbol: '00700',
    })
    expect(u1.some((u) => u.startsWith('hkex-announcement:'))).toBe(true)
    // 外层合法但嵌套 result 不是 JSON 字符串 → 同样带前缀
    const badNested: Resp = { ok: true, status: 200, text: async () => JSON.stringify({ result: '{broken' }) }
    const { unavailable: u2 } = await aggregateNews({
      fetch: hkRouteFetch({ emAnn: jsonResp(emAnnSameDisclosure), search: badNested }),
      now: NOW,
      symbol: '00700',
    })
    expect(u2.some((u) => u.startsWith('hkex-announcement:'))).toBe(true)
  })
})
