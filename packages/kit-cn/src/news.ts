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
  symbol?: string | undefined
  /** 时间窗（小时）：只保留 now - windowHours 内的条目；缺省 24。 */
  windowHours?: number | undefined
  /** 输出条数上限；缺省 20。 */
  limit?: number | undefined
  /** 依赖注入的 fetch（测试用 mock；缺省 globalThis.fetch）。 */
  fetch?: typeof globalThis.fetch | undefined
  /** 注入当前时间戳（ms，测试用）；缺省 Date.now()。 */
  now?: number | undefined
  /** CryptoPanic API token（桥面透传，cn/hk/us 聚合器忽略；对齐 api 契约形状）。 */
  cryptoPanicKey?: string | undefined
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
/** 下钻 fetch 统一 10s 超时（docs/replication.md §9；上游挂起不得拖垮 60s 轮询链）。 */
const UPSTREAM_TIMEOUT_MS = 10_000
/** 公告时间窗放宽：上市公司公告 7 天内有效展示（媒体快讯仍按 24h 窗）。 */
const ANNOUNCEMENT_MAX_AGE_MS = 7 * 24 * 3_600_000

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
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
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

async function fetchEastmoneyAnnouncements(fetchImpl: typeof globalThis.fetch, rawSymbol: string, limit: number): Promise<NewsItem[]> {
  const stockCode = rawSymbol.trim().replace(/\.(SH|SZ|BJ)$/i, '')
  if (!/^\d{6}$/.test(stockCode)) return []
  const url = new URL('https://np-anotice-stock.eastmoney.com/api/security/ann')
  url.searchParams.set('page_size', String(Math.max(limit, 20)))
  url.searchParams.set('page_index', '1')
  url.searchParams.set('ann_type', 'A')
  url.searchParams.set('client_source', 'web')
  url.searchParams.set('stock_list', stockCode)
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`eastmoney-announcement: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
  }
  const parsed: unknown = JSON.parse(await response.text())
  const list = (parsed as { data?: { list?: Array<{ art_code?: string; title?: string; display_time?: string; notice_date?: string }> } }).data?.list
  if (!Array.isArray(list)) throw new Error('eastmoney-announcement: unexpected payload (expected data.list[])')
  const items: NewsItem[] = []
  for (const it of list) {
    if (!it.title || !it.art_code) continue
    const timeStr = it.display_time || it.notice_date || ''
    const ts = parseCnShowTime(timeStr.slice(0, 19))
    // 解析失败丢弃该条，绝不回退「现在」——虚假新鲜事件会恒过时间窗并钉到最新 K 线。
    if (!Number.isFinite(ts)) continue
    items.push({
      source: 'eastmoney-announcement',
      title: it.title,
      url: `https://data.eastmoney.com/notices/detail/${stockCode}/${encodeURIComponent(it.art_code)}.html`,
      publishedAt: new Date(ts).toISOString(),
      relatedCodes: [stockCode],
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

  const tasks: Promise<NewsItem[]>[] = [fetchEastmoney(fetchImpl, limit)]
  if (options.symbol) {
    tasks.push(fetchEastmoneyAnnouncements(fetchImpl, options.symbol, limit))
  }

  const results = await Promise.allSettled(tasks)

  const items: NewsItem[] = []
  const unavailable: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        // 公告放宽时间窗（上市公司公告 7 天内均有效展示），媒体快讯按 24h 时间窗
        const maxAge = item.source === 'eastmoney-announcement' ? ANNOUNCEMENT_MAX_AGE_MS : windowMs
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
