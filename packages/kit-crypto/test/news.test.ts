/**
 * crypto_get_news 取数层/工具单测（WS2b，#3 验收：工具单测，mock fetch，不触真实网络）。
 *
 * 覆盖：四源聚合 + 倒序 + 截尾；币种过滤（base token 派生）；时间窗；单源失败容错
 * （unavailable 注明、不炸整体）；RSS 2.0 解析（CDATA/实体/无效 pubDate）；token 派生。
 * 夹具字段名/类型响应对齐 EVIDENCE 记录的真实响应形（Binance data.catalogs[].articles、
 * OKX data[0].details、RSS 2.0 title/link/pubDate）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { aggregateNews, parseRss2, deriveSymbolTokens, parseCryptoPanic } from '../src/news.ts'
import { createGetNewsTool } from '../src/index.ts'

const NOW = Date.parse('2026-08-30T20:00:00Z')
function iso(ms: number) { return new Date(ms).toISOString() }

type Resp = { ok: boolean; status: number; text: () => Promise<string> }
const jsonResp = (obj: unknown): Resp => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
const textResp = (str: string): Resp => ({ ok: true, status: 200, text: async () => str })
const failResp = (status: number, body = 'boom'): Resp => ({ ok: false, status, text: async () => body })

const binanceJson = {
  code: '000000',
  data: {
    catalogs: [
      { catalogId: 48, catalogName: 'New Cryptocurrency Listing', articles: [
        { id: 1, code: 'abc123', title: 'Binance Will Launch BTCUSDT Perpetual Contract', type: 1, releaseDate: NOW - 3_600_000 },
      ] },
      { catalogId: 93, catalogName: 'Latest Activities', articles: [
        { id: 2, code: 'noise', title: 'Ignored non-trading catalog', type: 1, releaseDate: NOW - 3_600_000 },
      ] },
    ],
  },
}

const okxJson = {
  code: '0',
  msg: '',
  data: [{ totalPage: 96, details: [
    { annType: 'announcements-deposit-withdrawal-suspension-resumption', title: 'OKX to suspend SOLANA withdrawal', url: 'https://www.okx.com/help/x', pTime: String(NOW - 7_200_000) },
  ] }],
}

const coinDeskRss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>CoinDesk</title>
  <item><title>Bitcoin rally stalls &amp; traders book profit</title><link>https://www.coindesk.com/markets/1</link><guid>a</guid><pubDate>Sun, 30 Aug 2026 19:00:00 +0000</pubDate></item>
  <item><title><![CDATA[Ethereum ETF inflows hit record]]></title><link>https://www.coindesk.com/markets/2</link><guid>b</guid><pubDate>Sat, 29 Aug 2026 10:00:00 +0000</pubDate></item>
</channel></rss>`

const theBlockRss = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel>
  <title>The Block</title>
  <item><title>Layer 1 chain halts mainnet</title><link>https://www.theblock.co/news/1</link><guid>c</guid><pubDate>Sun, 30 Aug 2026 16:00:00 +0000</pubDate></item>
</channel></rss>`

const cryptoPanicJson = {
  results: [
    { title: 'BTC ETF inflows push price', url: 'https://cryptopanic.com/news/1', published_at: '2026-08-30T18:30:00.000Z', currency: 'BTC' },
    { title: 'Solana outage reported', url: 'https://cryptopanic.com/news/2', published_at: 'bad-date', currency: 'SOL' },
  ],
}

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
    'binance.com': () => jsonResp(binanceJson),
    'okx.com': () => jsonResp(okxJson),
    'coindesk.com': () => textResp(coinDeskRss),
    'theblock.co': () => textResp(theBlockRss),
    'cointelegraph.com': () => textResp('<rss version="2.0"><channel><title>CoinTelegraph</title></channel></rss>'),
    'decrypt.co': () => textResp('<rss version="2.0"><channel><title>Decrypt</title></channel></rss>'),
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('aggregateNews（四源聚合 + 过滤）', () => {
  it('四源合并、按时间倒序、无参数默认过 24h 窗', async () => {
    const { items, unavailable } = await aggregateNews({ fetch: allSourcesOk(), now: NOW })
    expect(unavailable).toEqual([])
    // binance artifact now-1h, okx now-2h, theblock now-4h(16:00), coindesk now-1h(19:00)
    expect(items.map((i) => i.source).sort()).toEqual(['binance', 'coindesk', 'okx', 'theblock'])
    // 排序验证：19:00 (coindesk, now-1h) 应早于 binance? 两者同为 now-1h，看 releasedAt 精确值；这里断言整体倒序。
    const ts = items.map((i) => Date.parse(i.publishedAt))
    expect(ts).toEqual([...ts].sort((a, b) => b - a))
    // coindesk 第二条 29 日 10:00（now-34h）超窗被滤掉
    expect(items.some((i) => i.title.includes('ETF inflows'))).toBe(false)
    // binance 非交易分类 (93) 被滤掉
    expect(items.some((i) => i.title.includes('Ignored'))).toBe(false)
  })

  it('symbol 过滤：BTCUSDT → 命中 base token BTC 与全串；媒体纯名称标题不定命中（已知局限）', async () => {
    const { items } = await aggregateNews({ fetch: allSourcesOk(), now: NOW, symbol: 'BTCUSDT' })
    const titles = items.map((i) => i.title)
    expect(titles).toContain('Binance Will Launch BTCUSDT Perpetual Contract')
    // "Bitcoin rally..." 不含 BTC/BTCUSDT 子串 → 不命中（记录局限，非 bug）
    expect(titles.some((t) => t.includes('Bitcoin rally'))).toBe(false)
  })

  it('binance/okx 平台级公告绕过 symbol 过滤（有意设计：交易所公报对全平台有效，2026-09-02 评审 Question 裁决固化）', async () => {
    // BTCUSDT 过滤下：Binance 上币公报（无 BTC 词？——本题含 BTCUSDT，故换 SOL 侧 OKX 公报验证）
    const { items } = await aggregateNews({ fetch: allSourcesOk(), now: NOW, symbol: 'BTCUSDT' })
    // OKX 公报标题只含 SOLANA，不含 BTC/BTCUSDT，仍被保留 → 平台级公告豁免过滤
    expect(items.some((i) => i.source === 'okx' && i.title.includes('SOLANA'))).toBe(true)
  })

  it('windowHours 压缩时间窗：只留 now-1h 内', async () => {
    const { items } = await aggregateNews({ fetch: allSourcesOk(), now: NOW, windowHours: 1 })
    // binance (now-1h) 在界内；okx (now-2h) 与 theblock (now-4h) 被滤掉
    const sources = items.map((i) => i.source)
    expect(sources).toContain('binance')
    expect(sources).not.toContain('okx')
    expect(sources).not.toContain('theblock')
  })

  it('limit 截尾', async () => {
    const { items } = await aggregateNews({ fetch: allSourcesOk(), now: NOW, limit: 2 })
    expect(items).toHaveLength(2)
  })

  it('单源失败不炸整体，unavailable 注明该源', async () => {
    const fetchImpl = mockFetchByUrl({
      'binance.com': () => failResp(500),
      'okx.com': () => jsonResp(okxJson),
      'coindesk.com': () => textResp(coinDeskRss),
      'theblock.co': () => textResp(theBlockRss),
    })
    const { items, unavailable } = await aggregateNews({ fetch: fetchImpl, now: NOW })
    expect(unavailable.some((u) => u.includes('binance'))).toBe(true)
    expect(items.some((i) => i.source === 'okx')).toBe(true)
    expect(items.some((i) => i.source === 'coindesk')).toBe(true)
  })
})

describe('parseRss2（RSS 2.0 解析）', () => {
  it('解析 title/link/pubDate；CDATA 与实体解码；无效 pubDate 跳过', () => {
    const items = parseRss2(coinDeskRss, 'coindesk')
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('Bitcoin rally stalls & traders book profit') // &amp; → &
    expect(items[1].title).toBe('Ethereum ETF inflows hit record') // CDATA 剥除
    expect(items[0].url).toBe('https://www.coindesk.com/markets/1')
    expect(Date.parse(items[0].publishedAt)).toBe(Date.parse('2026-08-30T19:00:00Z'))
  })

  it('缺 pubDate 或 link → 跳过该条', () => {
    const xml = `<rss><channel><item><title>no link</title><pubDate>Sun, 30 Aug 2026 19:00:00 +0000</pubDate></item></channel></rss>`
    expect(parseRss2(xml, 'coindesk')).toHaveLength(0)
  })
})

describe('deriveSymbolTokens', () => {
  it('正常币对与 -SWAP 形派生 base', () => {
    expect(deriveSymbolTokens('BTCUSDT')).toEqual(['BTCUSDT', 'BTC'])
    expect(deriveSymbolTokens('BTCUSDT-SWAP')).toEqual(['BTCUSDT-SWAP', 'BTC'])
    expect(deriveSymbolTokens('')).toEqual([])
  })
})

describe('CryptoPanic（WS2c：有 key B 增强，失败降级）', () => {
  const keyOk = () => mockFetchByUrl({
    'binance.com': () => jsonResp(binanceJson),
    'okx.com': () => jsonResp(okxJson),
    'coindesk.com': () => textResp(coinDeskRss),
    'theblock.co': () => textResp(theBlockRss),
    'cryptopanic.com': () => jsonResp(cryptoPanicJson),
  })

  it('有 key：cryptopanic 源被聚合（B 增强），无 key 则不存在', async () => {
    const withKey = await aggregateNews({ fetch: keyOk(), now: NOW, cryptoPanicKey: 'sec_xyz' })
    expect(withKey.items.some((i) => i.source === 'cryptopanic')).toBe(true)
    const withoutKey = await aggregateNews({ fetch: allSourcesOk(), now: NOW })
    expect(withoutKey.items.some((i) => i.source === 'cryptopanic')).toBe(false)
  })

  it('有 key 但 cryptopanic 失败 → 降级：unavailable 注明 cryptopanic，公共源照常返回', async () => {
    const fetchImpl = mockFetchByUrl({
      'binance.com': () => jsonResp(binanceJson),
      'okx.com': () => jsonResp(okxJson),
      'coindesk.com': () => textResp(coinDeskRss),
      'theblock.co': () => textResp(theBlockRss),
      'cryptopanic.com': () => failResp(403),
    })
    const { items, unavailable } = await aggregateNews({ fetch: fetchImpl, now: NOW, cryptoPanicKey: 'sec_xyz' })
    expect(unavailable.some((u) => u.includes('cryptopanic'))).toBe(true)
    expect(items.some((i) => i.source === 'binance')).toBe(true)
    expect(items.some((i) => i.source === 'coindesk')).toBe(true)
  })

  it('parseCryptoPanic：解析 results[]，无效 published_at 跳过', () => {
    const items = parseCryptoPanic(cryptoPanicJson)
    expect(items).toHaveLength(1)
    expect(items[0].source).toBe('cryptopanic')
    expect(items[0].url).toBe('https://cryptopanic.com/news/1')
  })

  it('swap 符号：currencies 参数归一到币种代码（BTCUSDT-SWAP → BTC），不含合约后缀', async () => {
    const fetchImpl = mockFetchByUrl({
      'binance.com': () => jsonResp(binanceJson),
      'okx.com': () => jsonResp(okxJson),
      'coindesk.com': () => textResp(coinDeskRss),
      'theblock.co': () => textResp(theBlockRss),
      'cryptopanic.com': () => jsonResp(cryptoPanicJson),
    })
    await aggregateNews({ fetch: fetchImpl, now: NOW, symbol: 'BTCUSDT-SWAP', cryptoPanicKey: 'sec_xyz' })
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]))
    const panicUrl = urls.find((u) => u.includes('cryptopanic.com')) ?? ''
    expect(panicUrl).toContain('currencies=BTC')
    expect(panicUrl).not.toContain('SWAP')
  })
})

describe('createGetNewsTool（工具壳）', () => {
  it('execute 渲染：含来源、时间、链接与 unavailable 注明', async () => {
    // 工具走真实 Date.now() 过滤时间窗：夹具须锚定在「现在」附近（而非固定 NOW 常量），
    // 否则相对 UTC+8 本机时钟会成为「未来」条目被时间窗上界滤除（纯测试夹具问题）。
    const base = Date.now() - 3_600_000 // 1 小时前
    const nearBinance = { code: '000000', data: { catalogs: [{ catalogId: 48, articles: [{ id: 1, code: 'abc123', title: 'Binance Will Launch BTCUSDT Perpetual Contract', type: 1, releaseDate: base }] }] } }
    const nearOkx = { code: '0', data: [{ details: [{ title: 'OKX to suspend SOLANA withdrawal', url: 'https://www.okx.com/help/x', pTime: String(base) }] }] }
    const nearCoinDesk = `<rss><channel><item><title>Bitcoin rally stalls</title><link>https://www.coindesk.com/markets/1</link><guid>a</guid><pubDate>${new Date(base).toUTCString()}</pubDate></item></channel></rss>`
    const nearTheBlock = `<rss><channel><item><title>Layer 1 chain halts mainnet</title><link>https://www.theblock.co/news/1</link><guid>c</guid><pubDate>${new Date(base).toUTCString()}</pubDate></item></channel></rss>`
    const fetchImpl = mockFetchByUrl({
      'binance.com': () => jsonResp(nearBinance),
      'okx.com': () => jsonResp(nearOkx),
      'coindesk.com': () => textResp(nearCoinDesk),
      'theblock.co': () => textResp(nearTheBlock),
      'cointelegraph.com': () => textResp('<rss version="2.0"><channel><title>CT</title></channel></rss>'),
      'decrypt.co': () => textResp('<rss version="2.0"><channel><title>Dec</title></channel></rss>'),
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createGetNewsTool()
    expect(tool.name).toBe('crypto_get_news')
    const text = await tool.execute({ symbol: 'BTCUSDT', windowHours: 24, limit: 10 }) as string
    expect(text).toContain('crypto_get_news — ')
    expect(text).toContain('[binance]')
    expect(text).toContain('https://www.binance.com/en/support/announcement/abc123')
    expect(text).toContain('symbol=BTCUSDT')
    expect(text).not.toContain('source(s) unavailable') // 全源全成功，无缺席
  })

  it('有 key：输出标注 cryptopanicKey=set（B-source 注记），无 key 不加', async () => {
    const base = Date.now() - 1_800_000
    const nearBinance = { code: '000000', data: { catalogs: [{ catalogId: 48, articles: [{ id: 1, code: 'abc123', title: 'Binance Will Launch BTCUSDT Perpetual Contract', type: 1, releaseDate: base }] }] } }
    const nearPanic = { results: [{ title: 'BTC ETF inflows push price', url: 'https://cryptopanic.com/news/1', published_at: new Date(base).toISOString(), currency: 'BTC' }] }
    const fetchImpl = mockFetchByUrl({
      'binance.com': () => jsonResp(nearBinance),
      'okx.com': () => jsonResp({ code: '0', data: [] }),
      'cryptopanic.com': () => jsonResp(nearPanic),
      'coindesk.com': () => textResp(`<rss><channel><item><title>X</title><link>https://cd/x</link><guid>a</guid><pubDate>${new Date(base).toUTCString()}</pubDate></item></channel></rss>`),
      'theblock.co': () => textResp(`<rss><channel><item><title>Y</title><link>https://tb/y</link><guid>c</guid><pubDate>${new Date(base).toUTCString()}</pubDate></item></channel></rss>`),
      'cointelegraph.com': () => textResp('<rss version="2.0"><channel><title>CT</title></channel></rss>'),
      'decrypt.co': () => textResp('<rss version="2.0"><channel><title>Dec</title></channel></rss>'),
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createGetNewsTool({ cryptoPanicKey: 'sec_xyz' })
    const text = await tool.execute({ windowHours: 24, limit: 10 }) as string
    expect(text).toContain('cryptopanicKey=set (B-source)')
    expect(text).toContain('[cryptopanic]')
  })
})
