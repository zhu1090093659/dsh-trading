/**
 * cn_get_news 取数层（WS4 #1：#6 子工作流，spike/s impl-uscnhk-news EVIDENCE 推荐）。
 *
 * cn 主源 = 东方财富快讯 API（本出口 200 无 key；新浪/财联社不可用，spike C/D 级）：
 *   GET np-listapi.eastmoney.com/comm/web/getFastNewsList?fastColumn=102
 * 字段：fastNewsList[] = { title, showTime(YYYY-MM-DD HH:MM:SS, 东八区), code, summary(正文) }；
 * url 由 code 构造 finance.eastmoney.com/a/<code>.html（实测可达）。
 * 铁律 #5：summary 是正文，**只引 title/showTime/链接**（元数据），不取 summary 再分发。
 * 每源失败 fail-soft（unavailable 注明）；时间窗/标的过滤 + 排序截尾；defineTool 在 index.ts。
 */
export type NewsSource = 'eastmoney'

export interface NewsItem {
  /** 来源名（铁律 #5 的来源标注）。 */
  source: string
  title: string
  url: string
  /** ISO 8601 发布时间（东八区换算）。 */
  publishedAt: string
  /** 关联股票代码（东财快讯 stockList，供 symbol 过滤）。 */
  relatedCodes?: string[]
}

export interface AggregateNewsOptions {
  /** 标的（市场规范词汇，如 600519 / 600519.SH）；缺省 = 不过滤。 */
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
  unavailable: string[]
}

const EASTMONEY_URL = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList'
const DEFAULT_WINDOW_HOURS = 24
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (dsh-trading/cn_get_news)'

interface EastmoneyItem {
  title?: string
  showTime?: string
  code?: string | number
  /** 东财快讯关联标的：字符串数组 `<marketId>.<code>`（如 '1.600519'=SH、'116.02493'=HK、'105.AMZN'=US）。 */
  stockList?: string[]
}

/** 东财 showTime（YYYY-MM-DD HH:MM:SS，东八区无时区后缀）→ ISO。 */
export function parseCnShowTime(showTime: string): number {
  const t = Date.parse(showTime.trim().replace(' ', 'T') + '+08:00')
  return Number.isFinite(t) ? t : NaN
}

async function fetchEastmoney(fetchImpl: typeof globalThis.fetch, limit: number): Promise<NewsItem[]> {
  const url = new URL(EASTMONEY_URL)
  url.searchParams.set('client', 'web')
  url.searchParams.set('biz', 'web_724')
  url.searchParams.set('sortEnd', '')
  url.searchParams.set('req_trace', '1')
  url.searchParams.set('fastColumn', '102')
  url.searchParams.set('pageSize', String(Math.max(limit, 20)))
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
    const ts = typeof it.showTime === 'string' ? parseCnShowTime(it.showTime) : NaN
    if (!Number.isFinite(ts)) continue
    // relatedCodes 保留完整 `<marketId>.<code>`（如 '1.600519'/'116.00700'），匹配时取 code 段。
    const relatedCodes = Array.isArray(it.stockList)
      ? it.stockList.filter((s) => typeof s === 'string' && s.includes('.'))
      : undefined
    items.push({
      source: 'eastmoney',
      title: it.title,
      url: `https://finance.eastmoney.com/a/${encodeURIComponent(String(it.code))}.html`,
      publishedAt: new Date(ts).toISOString(),
      ...(relatedCodes && relatedCodes.length > 0 ? { relatedCodes } : {}),
    })
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
  const base = needle.replace(/\.(SH|SZ|BJ)$/i, '')
  // cn 标题常用公司中文名（贵州茅台）非代码（600519）——先按代码匹配标题或关联股票代码（stockList），
  // 中文名匹配是已知局限（不隐式建名称映射）。
  const tokens = [needle.toUpperCase(), base.toUpperCase()]
  if (tokens.some((t) => t && title.includes(t))) return true
  if (item.relatedCodes) {
    // 东财 code = `<marketId>.<code>`；按 . 后 code 段匹配（'1.600519' → '600519'）。
    const codes = item.relatedCodes.map((c) => c.split('.').slice(-1)[0].toUpperCase())
    return tokens.some((t) => t && codes.includes(t))
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

  const results = await Promise.allSettled([fetchEastmoney(fetchImpl, limit)])

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
