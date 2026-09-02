/**
 * us_get_news 取数层/工具单测（WS4 #1：#6；spike EVIDENCE 推荐 Yahoo + Google News RSS）。
 * mock fetch，不触真实网络。覆盖：两源聚合/倒序/截尾、symbol 过滤、时间窗、单源容错、RSS 解析。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { aggregateNews, parseGoogleNewsRss, parseSecEdgarAtom } from '../src/news.ts'
import { createGetNewsTool } from '../src/index.ts'

const NOW = Date.parse('2026-08-30T20:00:00Z')

type Resp = { ok: boolean; status: number; text: () => Promise<string> }
const jsonResp = (obj: unknown): Resp => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
const textResp = (str: string): Resp => ({ ok: true, status: 200, text: async () => str })
const failResp = (status: number, body = 'boom'): Resp => ({ ok: false, status, text: async () => body })

const yahooJson = {
  news: [
    { uuid: '1', title: 'AAPL: Apple beats Q3 earnings estimates', link: 'https://finance.yahoo.com/1', publisher: 'Yahoo Finance', providerPublishTime: NOW / 1000 - 3600 },
    { uuid: '2', title: 'TSLA shares tumble on delivery miss', link: 'https://finance.yahoo.com/2', publisher: 'Reuters', providerPublishTime: NOW / 1000 - 7200 },
  ],
}

const googleRss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Google News</title>
  <item><title>Apple stock hits record high &amp; more</title><link>https://news.google.com/rss/articles/a</link><guid>a</guid><pubDate>Sun, 30 Aug 2026 18:00:00 GMT</pubDate><source url="https://example.com">MarketWatch</source></item>
  <item><title>Amazon retail sales beat estimates</title><link>https://news.google.com/rss/articles/b</link><guid>b</guid><pubDate>Sat, 29 Aug 2026 09:00:00 GMT</pubDate><source>CNBC</source></item>
</channel></rss>`

function mockFetchByUrl(responses: Record<string, () => Resp>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const hit = Object.entries(responses).find(([substr]) => url.includes(substr))
    if (!hit) throw new Error(`unexpected fetch: ${url}`)
    return hit[1]()
  }) as unknown as typeof globalThis.fetch
}

function allSourcesOk() {
  return mockFetchByUrl({
    'finance.yahoo.com': () => jsonResp(yahooJson),
    'news.google.com': () => textResp(googleRss),
    'sec.gov': () => textResp('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>8-K - Current report</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20260830.htm"/><updated>2026-08-30T19:30:00Z</updated></entry></feed>'),
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('aggregateNews（两源聚合 + 过滤）', () => {
  it('两源合并、按时间倒序、无参数默认过 24h 窗；source = 原始 publisher', async () => {
    const { items, unavailable } = await aggregateNews({ fetch: allSourcesOk(), now: NOW })
    expect(unavailable).toEqual([])
    expect(items.map((i) => i.source).sort()).toEqual(['MarketWatch', 'Reuters', 'Yahoo Finance'])
    const ts = items.map((i) => Date.parse(i.publishedAt))
    expect(ts).toEqual([...ts].sort((a, b) => b - a))
    // google rss 第二条 29 日 09:00（now-35h）超窗被滤
    expect(items.some((i) => i.title.includes('Amazon'))).toBe(false)
  })

  it('symbol 过滤：AAPL 命中含 "AAPL" 标题；媒体用全名（Apple）不命中（已知局限）', async () => {
    const { items } = await aggregateNews({ fetch: allSourcesOk(), now: NOW, symbol: 'AAPL' })
    const titles = items.map((i) => i.title)
    expect(titles).toContain('AAPL: Apple beats Q3 earnings estimates')
    expect(titles.some((t) => t.includes('TSLA'))).toBe(false)
    expect(titles.some((t) => t.includes('Apple stock hits record high'))).toBe(false) // "Apple..." 不含 AAPL
  })

  it('windowHours 压缩时间窗 + limit 截尾', async () => {
    const { items } = await aggregateNews({ fetch: allSourcesOk(), now: NOW, windowHours: 1, limit: 1 })
    expect(items).toHaveLength(1)
  })

  it('单源失败不炸整体，unavailable 注明该源', async () => {
    const fetchImpl = mockFetchByUrl({
      'finance.yahoo.com': () => failResp(500),
      'news.google.com': () => textResp(googleRss),
    })
    const { items, unavailable } = await aggregateNews({ fetch: fetchImpl, now: NOW })
    expect(unavailable.some((u) => u.includes('yahoo'))).toBe(true)
    expect(items.some((i) => i.source === 'MarketWatch')).toBe(true)
  })
})

describe('parseGoogleNewsRss（RSS 2.0 解析）', () => {
  it('解析 title/link/pubDate；source 为原始媒体名；无效 pubDate 跳过', () => {
    const items = parseGoogleNewsRss(googleRss)
    expect(items).toHaveLength(2)
    expect(items[0].source).toBe('MarketWatch')
    expect(items[0].url).toBe('https://news.google.com/rss/articles/a')
  })
})

describe('parseSecEdgarAtom（SEC EDGAR 披露流解析）', () => {
  it('解析 entry 中的 8-K/10-Q 标题、直达链接与更新时间', () => {
    const secAtom = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>8-K - Current report</title>
        <link href="https://www.sec.gov/Archives/edgar/data/320193/aapl.htm"/>
        <updated>2026-08-30T19:30:00Z</updated>
      </entry>
    </feed>`
    const items = parseSecEdgarAtom(secAtom)
    expect(items).toHaveLength(1)
    expect(items[0].source).toBe('sec-edgar')
    expect(items[0].title).toBe('8-K - Current report')
    expect(items[0].url).toBe('https://www.sec.gov/Archives/edgar/data/320193/aapl.htm')
  })
})

describe('createGetNewsTool（工具壳）', () => {
  it('execute 渲染：含来源、时间、链接、symbol 与 unavailable 注记', async () => {
    const base = Date.now() - 3_600_000
    const nearYahoo = { news: [{ uuid: '1', title: 'AAPL: Apple beats Q3 earnings estimates', link: 'https://finance.yahoo.com/1', publisher: 'Reuters', providerPublishTime: base / 1000 }] }
    const nearGoogle = `<rss><channel><item><title>Apple stock record</title><link>https://news.google.com/a</link><guid>a</guid><pubDate>${new Date(base).toUTCString()}</pubDate><source>MarketWatch</source></item></channel></rss>`
    const fetchImpl = mockFetchByUrl({
      'finance.yahoo.com': () => jsonResp(nearYahoo),
      'news.google.com': () => textResp(nearGoogle),
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createGetNewsTool()
    expect(tool.name).toBe('us_get_news')
    const text = await tool.execute({ symbol: 'AAPL', windowHours: 24, limit: 10 }) as string
    expect(text).toContain('us_get_news — ')
    expect(text).toContain('[Reuters]')
    expect(text).toContain('https://finance.yahoo.com/1')
    expect(text).toContain('symbol=AAPL')
    expect(text).not.toContain('source(s) unavailable')
  })
})
