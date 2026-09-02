/**
 * us_get_news 取数层（WS4 #1：#6 子工作流，spike/s impl-uscnhk-news EVIDENCE 推荐）。
 *
 * 两源均为单端点、无鉴权、无状态公共 GET（本出口实测）：
 *   - Yahoo Finance news API（v8 家族，与既有 connector-yahoo 同族）——JSON，news[] 带 publisher/link/publishTime
 *   - Google News RSS（news.google.com/rss/search）——RSS 2.0，<source> 为原始媒体名；link 为 Google 跳转链接
 * 本模块只做取数 + 归一化为 NewsItem[]；时间窗/币种过滤 + 排序截尾；defineTool 装配在 index.ts。
 * 铁律 #5：输出只带元数据（来源名/标题/链接/发布时间），不取正文，不缓存，不再分发。
 * 每源独立容错：单源失败不炸整体，失败源在 `unavailable` 中注明，fail-soft。
 */
export type NewsSource = 'yahoo' | 'googlenews'

export interface NewsItem {
  /** 来源名（铁律 #5 的来源标注）。 */
  source: string
  title: string
  url: string
  /** ISO 8601 发布时间。 */
  publishedAt: string
}

export interface AggregateNewsOptions {
  /** 标的（市场规范词汇，如 AAPL）；缺省 = 通用市场主题。 */
  symbol?: string
  /** 时间窗（小时）：只保留 now - windowHours 内的条目；缺省 24。 */
  windowHours?: number
  /** 输出条数上限；缺省 20。 */
  limit?: number
  /** 依赖注入的 fetch（测试用 mock；缺省 globalThis.fetch）。 */
  fetch?: typeof globalThis.fetch
  /** 注入当前时间戳（ms，测试用）；缺省 Date.now()。 */
  now?: number
}

export interface AggregateNewsResult {
  items: NewsItem[]
  /** 取数失败的源：`<匿名>`（如 'yahoo: HTTP 500 — ...'），工具输出需注明缺席。 */
  unavailable: string[]
}

const YAHOO_SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search'
const GOOGLE_NEWS_RSS_URL = 'https://news.google.com/rss/search'

const DEFAULT_WINDOW_HOURS = 24
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (dsh-trading/us_get_news)'
/** 无 symbol 时的通用市场主题（避免空 query）。 */
const DEFAULT_QUERY_TOPIC = 'US stock market'

async function fetchText(url: string, fetchImpl: typeof globalThis.fetch, name: string): Promise<string> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json, text/xml, */*', 'user-agent': UA } })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${name}: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
  }
  return response.text()
}

/* ── Yahoo Finance news API（JSON；news[] 字段齐） ─────────────────────────── */

interface YahooNewsItem {
  title?: string
  link?: string
  publisher?: string
  providerPublishTime?: number
}

async function fetchYahooNews(fetchImpl: typeof globalThis.fetch, topic: string, limit: number): Promise<NewsItem[]> {
  const url = new URL(YAHOO_SEARCH_URL)
  url.searchParams.set('q', topic)
  url.searchParams.set('newsCount', String(limit))
  url.searchParams.set('quotesCount', '0')
  url.searchParams.set('enableFuzzyQuery', 'false')
  const text = await fetchText(url.toString(), fetchImpl, 'yahoo')
  const parsed: unknown = JSON.parse(text)
  const news = (parsed as { news?: YahooNewsItem[] }).news
  if (!Array.isArray(news)) throw new Error('yahoo: unexpected payload (expected news[])')
  const items: NewsItem[] = []
  for (const n of news) {
    if (!n.title || !n.link) continue
    const ts = typeof n.providerPublishTime === 'number' ? n.providerPublishTime * 1000 : NaN
    if (!Number.isFinite(ts)) continue
    items.push({
      source: n.publisher || 'yahoo',
      title: n.title,
      url: n.link,
      publishedAt: new Date(ts).toISOString(),
    })
  }
  return items
}

/* ── Google News RSS（RSS 2.0；<source> 为原始媒体名） ─────────────────────── */

function decodeXmlText(raw: string): string {
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, m) => m)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim()
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'i')
  const match = block.match(re)
  if (!match) return ''
  return decodeXmlText(match[0].replace(new RegExp(`<\\/?${tag}[^>]*>`, 'gi'), ''))
}

/** 解析 Google News RSS（title/link/pubDate/source；link 为 Google 跳转，溯源用 source）。 */
export function parseGoogleNewsRss(xml: string): NewsItem[] {
  const items: NewsItem[] = []
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []
  for (const block of blocks) {
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link')
    if (!title || !link) continue
    const pubDate = extractTag(block, 'pubDate')
    const ts = Date.parse(pubDate)
    if (!Number.isFinite(ts)) continue
    const source = extractTag(block, 'source') || 'googlenews'
    items.push({ source, title, url: link, publishedAt: new Date(ts).toISOString() })
  }
  return items
}

async function fetchGooglenews(fetchImpl: typeof globalThis.fetch, topic: string, limit: number): Promise<NewsItem[]> {
  const url = new URL(GOOGLE_NEWS_RSS_URL)
  url.searchParams.set('q', topic)
  url.searchParams.set('hl', 'en-US')
  url.searchParams.set('gl', 'US')
  url.searchParams.set('ceid', 'US:en')
  const text = await fetchText(url.toString(), fetchImpl, 'googlenews')
  return parseGoogleNewsRss(text).slice(0, limit)
}

/* ── SEC EDGAR 官方披露 Atom Feed（Form 8-K / 10-Q / 10-K / Form 4 等） ─────────── */

export function parseSecEdgarAtom(xml: string): NewsItem[] {
  const items: NewsItem[] = []
  const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? []
  for (const entry of entries) {
    const title = extractTag(entry, 'title')
    let link = extractTag(entry, 'link')
    if (!link) {
      const hrefMatch = entry.match(/<link[^>]+href="([^">]+)"/i)
      if (hrefMatch) link = hrefMatch[1] ?? ''
    }
    if (!title || !link) continue
    const updated = extractTag(entry, 'updated') || extractTag(entry, 'published')
    const ts = Date.parse(updated)
    if (!Number.isFinite(ts)) continue
    items.push({
      source: 'sec-edgar',
      title: title.replace(/\s+/g, ' ').trim(),
      url: link,
      publishedAt: new Date(ts).toISOString(),
    })
  }
  return items
}

async function fetchSecEdgarAnnouncements(fetchImpl: typeof globalThis.fetch, symbol: string, limit: number): Promise<NewsItem[]> {
  const clean = symbol.trim().toUpperCase()
  if (!clean || clean === DEFAULT_QUERY_TOPIC.toUpperCase()) return []
  const url = new URL('https://www.sec.gov/cgi-bin/browse-edgar')
  url.searchParams.set('action', 'getcompany')
  url.searchParams.set('CIK', clean)
  url.searchParams.set('type', '')
  url.searchParams.set('dateb', '')
  url.searchParams.set('owner', 'exclude')
  url.searchParams.set('start', '0')
  url.searchParams.set('count', String(Math.max(limit, 20)))
  url.searchParams.set('output', 'atom')
  try {
    const text = await fetchText(url.toString(), fetchImpl, 'sec-edgar')
    return parseSecEdgarAtom(text).slice(0, limit)
  } catch {
    return []
  }
}

/* ── 聚合：并发取源 → 时间窗/标的过滤 → 按时间倒序 → 截尾 ──────────────────── */

function inWindow(publishedAt: string, nowMs: number, windowMs: number): boolean {
  const ts = Date.parse(publishedAt)
  if (!Number.isFinite(ts)) return false
  return ts >= nowMs - windowMs && ts <= nowMs + 60_000 // 允许 1 分钟时钟误差
}

function matchesSymbol(item: NewsItem, rawSymbol?: string): boolean {
  if (!rawSymbol) return true
  const needle = rawSymbol.trim().toUpperCase()
  if (!needle) return true
  const title = item.title.toUpperCase()
  // sec-edgar 本身按 CIK/Ticker 抓取，直接命中
  if (item.source === 'sec-edgar') return true
  return title.includes(needle)
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

export async function aggregateNews(options: AggregateNewsOptions = {}): Promise<AggregateNewsResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now()
  const windowHours = clampNumber(options.windowHours, DEFAULT_WINDOW_HOURS, 1, 24 * 7)
  const windowMs = windowHours * 3_600_000
  const limit = clampNumber(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  const topic = (options.symbol?.trim() || DEFAULT_QUERY_TOPIC)

  const fetchers: Promise<NewsItem[]>[] = [
    fetchYahooNews(fetchImpl, topic, limit),
    fetchGooglenews(fetchImpl, topic, limit),
  ]
  if (options.symbol && options.symbol.trim()) {
    fetchers.push(fetchSecEdgarAnnouncements(fetchImpl, options.symbol, limit))
  }

  const results = await Promise.allSettled(fetchers)

  const items: NewsItem[] = []
  const unavailable: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        // SEC 官方公报放宽时间窗到 30 天，媒体快讯按 24h 时间窗
        const maxAge = item.source === 'sec-edgar' ? 30 * 24 * 3_600_000 : windowMs
        if (!inWindow(item.publishedAt, now, maxAge)) continue
        if (!matchesSymbol(item, options.symbol)) continue
        items.push(item)
      }
    } else {
      unavailable.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
    }
  }
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  return { items: items.slice(0, limit), unavailable }
}
