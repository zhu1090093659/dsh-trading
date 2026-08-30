/**
 * hk_get_news 取数层（WS4 #1：#6 子工作流；spike EVIDENCE 判定 hk 无干净公共源 → 采用「降级」方案）。
 *
 * 降级口径（用户裁决 2026-08-30）：用东方财富快讯第 103 列（「港股」列，但实为统一 CN 金融流、覆盖不纯），
 * 客户端按 `stockList` 中的**港交所 marketId=116** 代码 + 标题港股关键词过滤出港股相关标的新闻。诚实标注：
 * 覆盖**部分**（港股新闻若不带港股关联代码/关键词则不捕获），非专用港股新闻源；与 CryptoPanic 的降级同理。
 *
 * 铁律 #5：只引 title/showTime/链接（元数据），不取 summary/正文，不再分发。每源失败 fail-soft。
 */
export type NewsSource = 'eastmoney'

export interface NewsItem {
  source: string
  title: string
  url: string
  publishedAt: string
  relatedCodes?: string[]
}

export interface AggregateNewsOptions {
  /** 标的（市场规范词汇，如 00700 / 00700.HK / 0700）；缺省 = 不过滤。 */
  symbol?: string
  windowHours?: number
  limit?: number
  fetch?: typeof globalThis.fetch
  now?: number
}

export interface AggregateNewsResult {
  items: NewsItem[]
  unavailable: string[]
}

const EASTMONEY_URL = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList'
const DEFAULT_WINDOW_HOURS = 24
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (dsh-trading/hk_get_news)'
/** 港交所 marketId（stockList 前缀，如 '116.00700'）。 */
const HK_MARKET_ID = '116.'
/** 港股关键词（无关联代码时仍判为港股相关）。 */
const HK_KEYWORDS = ['港股', '港交所', '香港', '恒指', '恒生']

interface EastmoneyItem {
  title?: string
  showTime?: string
  code?: string | number
  stockList?: string[]
}

export function parseHkShowTime(showTime: string): number {
  const t = Date.parse(showTime.trim().replace(' ', 'T') + '+08:00')
  return Number.isFinite(t) ? t : NaN
}

/** 港股相关性：stockList 含 116. 前缀代码（港交所），或 title 含港股关键词。 */
export function isHkRelevant(item: { title: string; relatedCodes?: string[] }): boolean {
  if (item.relatedCodes?.some((c) => c.startsWith(HK_MARKET_ID))) return true
  const title = item.title.toUpperCase()
  return HK_KEYWORDS.some((k) => title.includes(k.toUpperCase()))
}

async function fetchEastmoneyHk(fetchImpl: typeof globalThis.fetch, limit: number): Promise<NewsItem[]> {
  const url = new URL(EASTMONEY_URL)
  url.searchParams.set('client', 'web')
  url.searchParams.set('biz', 'web_724')
  url.searchParams.set('sortEnd', '')
  url.searchParams.set('req_trace', '1')
  url.searchParams.set('fastColumn', '103')
  url.searchParams.set('pageSize', String(Math.max(limit * 2, 40)))
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA } })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`eastmoney: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
  }
  const parsed: unknown = JSON.parse(await response.text())
  const list = (parsed as { data?: { fastNewsList?: EastmoneyItem[] } }).data?.fastNewsList
  if (!Array.isArray(list)) throw new Error('eastmoney: unexpected payload (expected data.fastNewsList[])')
  const items: NewsItem[] = []
  for (const it of list) {
    if (!it.title || it.code === undefined) continue
    const ts = typeof it.showTime === 'string' ? parseHkShowTime(it.showTime) : NaN
    if (!Number.isFinite(ts)) continue
    const relatedCodes = Array.isArray(it.stockList)
      ? it.stockList.filter((s) => typeof s === 'string' && s.includes('.'))
      : undefined
    const candidate: NewsItem = {
      source: 'eastmoney',
      title: it.title,
      url: `https://finance.eastmoney.com/a/${encodeURIComponent(String(it.code))}.html`,
      publishedAt: new Date(ts).toISOString(),
      ...(relatedCodes && relatedCodes.length > 0 ? { relatedCodes } : {}),
    }
    // 降级：仅保留港股相关信息（116. 代码 或 港股关键词）。
    if (isHkRelevant(candidate)) {
      items.push(candidate)
    }
  }
  return items
}

function inWindow(publishedAt: string, nowMs: number, windowMs: number): boolean {
  const ts = Date.parse(publishedAt)
  if (!Number.isFinite(ts)) return false
  return ts >= nowMs - windowMs && ts <= nowMs + 60_000
}

function matchesSymbol(item: NewsItem, rawSymbol?: string): boolean {
  const needle = rawSymbol?.trim()
  if (!needle) return true
  const title = item.title.toUpperCase()
  // hk 符号规范：00700 / 00700.HK / 0700（补零归一化 5 位）。
  const normalizedNeedle = needle.toUpperCase().replace(/\.HK$/i, '').replace(/^0+/, '')
  const tokens = [needle.toUpperCase(), normalizedNeedle]
  if (tokens.some((t) => t && title.includes(t))) return true
  if (item.relatedCodes) {
    // 港股代码：`116.00700` → 匹配 116. 前缀 + 去前导零后的 code 段（00700 → 00700）。
    return tokens.some((t) => t && item.relatedCodes!.some((c) => c.startsWith('116.') && c.slice(4).replace(/^0+/, '') === t))
  }
  return false
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

  const results = await Promise.allSettled([fetchEastmoneyHk(fetchImpl, limit)])

  const items: NewsItem[] = []
  const unavailable: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        if (!inWindow(item.publishedAt, now, windowMs)) continue
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
