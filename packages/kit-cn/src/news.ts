/**
 * cn_get_news 取数层（WS4 #1：#6 子工作流，spike/s impl-uscnhk-news EVIDENCE 推荐）。
 *
 * cn 主源 = 东方财富快讯 API（本出口 200 无 key；新浪/财联社不可用，spike C/D 级）：
 *   GET np-listapi.eastmoney.com/comm/web/getFastNewsList?fastColumn=102
 * 字段：fastNewsList[] = { title, showTime(YYYY-MM-DD HH:MM:SS, 东八区), code, summary(正文) }；
 * url 由 code 构造 finance.eastmoney.com/a/<code>.html（实测可达）。
 * 铁律 #5：summary 是正文，**只引 title/showTime/链接**（元数据），不取 summary 再分发。
 * 每源失败 fail-soft（unavailable 注明）；时间窗/标的过滤 + 排序截尾；defineTool 在 index.ts。
 *
 * 公告双源（2026-09-03，多供应商冗余裁决；spikes/impl-hk-cn-announce-sources/ EVIDENCE）：
 * 东财公告接口（主源，秒级时间）+ 巨潮资讯 hisAnnouncement（备份源，沪深分列），allSettled 并行 +
 * 跨源去重（±24h 内：归一化标题全文等值，或共同前缀 ≥6 字且共同后缀 ≥2 字——
 * 2026-09-03 评审 M1 收紧：裸类别短标题/「摘要」类严格前缀/泛化日期头（截至二零二六年…）
 * 同日不同文件不判重，失败方向宁漏勿误）。
 */
export type NewsSource = 'eastmoney' | 'eastmoney-announcement' | 'cninfo-announcement'

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
const CNINFO_BASE = 'https://www.cninfo.com.cn'
const CNINFO_PDF_BASE = 'https://static.cninfo.com.cn/'
const DEFAULT_WINDOW_HOURS = 24
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (dsh-trading/cn_get_news)'
/** 下钻 fetch 统一 10s 超时（docs/replication.md §9；上游挂起不得拖垮 60s 轮询链）。 */
const UPSTREAM_TIMEOUT_MS = 10_000
/** 公告时间窗放宽：上市公司公告 7 天内有效（法定披露低频，媒体快讯 24h 窗）。 */
const ANNOUNCEMENT_MAX_AGE_MS = 7 * 24 * 3_600_000
/** 巨潮公告检索请求窗：宽于 7 天过滤窗，避免日期边界裁剪（seDate 日精度）。 */
const CNINFO_REQUEST_WINDOW_MS = 14 * 24 * 3_600_000

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

/* -- 巨潮资讯公告源（spikes/impl-hk-cn-announce-sources/ EVIDENCE，A 级；沪深分列）-- */

/** 股票代码 → 巨潮 orgId memo（topSearch 联想接口 ~236ms，orgId 是稳定静态映射；仅缓存成功值）。
 * 失败负缓存 5 分钟（评审 L1）：上游故障期间不再每轮 60s 轮询重付 10s 超时尾延迟。
 * 并发合并：in-flight promise 共享（评审 L1），同标的首轮并发轮询只发一次 lookup。
 */
const cninfoOrgIdMemo = new Map<string, string>()
const cninfoOrgIdFailureMemo = new Map<string, number>()
const cninfoOrgIdInflight = new Map<string, Promise<string>>()
/** 失败负缓存 TTL：5 分钟内不重试失败的 orgId lookup。 */
const LOOKUP_FAILURE_TTL_MS = 5 * 60_000

/** 清空巨潮 orgId memo（单测隔离用；生产运行期不需要调用）。 */
export function resetCninfoAnnouncementMemo(): void {
  cninfoOrgIdMemo.clear()
  cninfoOrgIdFailureMemo.clear()
  cninfoOrgIdInflight.clear()
}

async function fetchCninfoOrgId(fetchImpl: typeof globalThis.fetch, code: string): Promise<string> {
  const cached = cninfoOrgIdMemo.get(code)
  if (cached !== undefined) return cached
  const failedAt = cninfoOrgIdFailureMemo.get(code)
  if (failedAt !== undefined && Date.now() - failedAt < LOOKUP_FAILURE_TTL_MS) {
    throw new Error('cninfo: lookup recently failed (negative cache, retry later)')
  }
  let inflight = cninfoOrgIdInflight.get(code)
  if (inflight === undefined) {
    inflight = fetchCninfoOrgIdUncached(fetchImpl, code).finally(() => { cninfoOrgIdInflight.delete(code) })
    cninfoOrgIdInflight.set(code, inflight)
  }
  return inflight
}

async function fetchCninfoOrgIdUncached(fetchImpl: typeof globalThis.fetch, code: string): Promise<string> {
  const url = new URL(`${CNINFO_BASE}/new/information/topSearch/detailOfQuery`)
  url.searchParams.set('keyWord', code)
  url.searchParams.set('maxSecNum', '10')
  url.searchParams.set('maxListNum', '5')
  // POST 无 body：服务端要求 Content-Length 存在（裸 POST 无该头返回 411），undici 对空串 body 发 Content-Length: 0。
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'POST', body: '', headers: { accept: '*/*', 'user-agent': UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  } catch (err) {
    cninfoOrgIdFailureMemo.set(code, Date.now())
    throw err
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    cninfoOrgIdFailureMemo.set(code, Date.now())
    throw new Error(`cninfo: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
  }
  const text = await response.text().catch((err: unknown) => { throw err instanceof Error ? err : new Error(String(err)) })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    cninfoOrgIdFailureMemo.set(code, Date.now())
    throw new Error('cninfo: unexpected payload (invalid JSON)')
  }
  const list = (parsed as { keyBoardList?: Array<{ code?: string; orgId?: string }> }).keyBoardList
  // 评审 M2：去掉 `?? list[0]` 模糊兜底——联想接口的非精确命中可能是另一家公司，
  // 错 orgId 进 memo 后其公告带本标的 relatedCodes 下发，属零假数据红线；未命中直接 throw（fail-soft 可重试）。
  const hit = Array.isArray(list) ? list.find((it) => it.code === code) : undefined
  if (typeof hit?.orgId !== 'string' || hit.orgId.length === 0) {
    cninfoOrgIdFailureMemo.set(code, Date.now())
    throw new Error('cninfo: unexpected payload (expected keyBoardList[].orgId for exact code match)')
  }
  cninfoOrgIdMemo.set(code, hit.orgId)
  return hit.orgId
}

interface CninfoAnnouncement {
  secCode?: string
  announcementTitle?: string
  announcementTime?: number
  adjunctUrl?: string
}

/** 请求窗日期串（YYYY-MM-DD，东八区日历日，评审 M3：巨潮 seDate 按 +08:00 日精度截窗，UTC 日期会在每天 00:00–07:59 漏掉当日公告）。 */
function ymdHk(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10)
}

async function fetchCninfoAnnouncements(fetchImpl: typeof globalThis.fetch, rawSymbol: string, limit: number, nowMs: number): Promise<NewsItem[]> {
  const stockCode = rawSymbol.trim().replace(/\.(SH|SZ|BJ)$/i, '')
  if (!/^\d{6}$/.test(stockCode)) return []
  // 沪深分列（spike EVIDENCE）：6 开头沪市 column=sse，0/3 开头深市 column=szse。
  // 评审 M4：北交所（43/83/87/92 开头，spike 未验证其列归属）不查询——走 szse 恒返空且与真实无公告不可区分，宁缺勿错。
  if (!/^(6|0|3)/.test(stockCode)) return []
  const column = stockCode.startsWith('6') ? 'sse' : 'szse'
  const orgId = await fetchCninfoOrgId(fetchImpl, stockCode)
  const now = nowMs
  const form = new URLSearchParams({
    pageNum: '1',
    pageSize: String(Math.max(limit, 20)),
    column,
    tabName: 'fulltext',
    plate: '',
    stock: `${stockCode},${orgId}`,
    searchkey: '',
    secid: '',
    category: '',
    trade: '',
    seDate: `${ymdHk(now - CNINFO_REQUEST_WINDOW_MS)}~${ymdHk(now)}`,
    sortName: '',
    sortType: '',
    isHLtitle: 'true',
  })
  const response = await fetchImpl(`${CNINFO_BASE}/new/hisAnnouncement/query`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`cninfo-announcement: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
  }
  // 评审 L2：坏 JSON 也要带来源前缀进 unavailable，不能裸 SyntaxError 无归因。
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.text())
  } catch {
    throw new Error('cninfo-announcement: unexpected payload (invalid JSON)')
  }
  // 窗内无公告时该字段是 null（合法空），只有出现非数组非空的形状才算异常。
  const raw = (parsed as { announcements?: CninfoAnnouncement[] | null }).announcements
  if (raw !== null && raw !== undefined && !Array.isArray(raw)) throw new Error('cninfo-announcement: unexpected payload (expected announcements[])')
  const list: CninfoAnnouncement[] = Array.isArray(raw) ? raw : []
  const items: NewsItem[] = []
  for (const it of list) {
    if (!it.announcementTitle || !it.adjunctUrl) continue
    // 评审 M2 第二道守卫：发射前核对 secCode === 请求代码，防止上游返回错公司条目冒充本标的披露。
    if (typeof it.secCode === 'string' && it.secCode !== stockCode) continue
    // announcementTime 只有日精度（00:00+08 的 epoch ms）；解析失败丢弃该条，绝不回退「现在」。
    const ts = typeof it.announcementTime === 'number' && Number.isFinite(it.announcementTime) ? it.announcementTime : NaN
    if (!Number.isFinite(ts)) continue
    items.push({
      source: 'cninfo-announcement',
      title: it.announcementTitle,
      url: `${CNINFO_PDF_BASE}${it.adjunctUrl.replace(/^\//, '')}`,
      publishedAt: new Date(ts).toISOString(),
      relatedCodes: [stockCode],
    })
  }
  return items
}

/* -- 跨源公告去重（东财 ↔ 巨潮同一条披露会同时出现，不去重则公告页签/图钉成对假事件）-- */

/** 公告标题归一化：去公司名前缀（东财习惯 `公司:标题`，巨潮标题无前缀）→ 去全部标点/符号/空白。 */
function normalizeAnnouncementTitle(title: string): string {
  return title.replace(/^[^：:]*[：:]\s*/, '').replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 公告标题以类别开头（H股公告/关于回购/半年度报告…），两边括注与措辞差异使全文等值不可靠。
 * 前缀判重的收紧口径（2026-09-03 评审 M1）：共同前缀 ≥6 字之外还要求**共同后缀 ≥2 字**。
 * 三类真实误删对因此被排除：裸类别短标题（`翌日披露报表` 恰 6 字 vs 长标题，长边结尾不同）、
 * 严格前缀对（`…半年度报告` vs `…半年度报告摘要`，短边被长边整体覆盖无共同后缀）、
 * 泛化日期头（`截至二零二六年七月…月报表` vs `截至二零二六年六月三十日…业绩公布`，尾部不吻合）。
 * 仍能兜住真实变体对（同一文件在两源的括注/繁简/措辞差异，头尾主体一致）——失败方向只剩
 * 漏去重（重复展示），不是误删（宁漏勿误）。
 */
function isCrossSourceDup(a: NewsItem, b: NewsItem): boolean {
  if (a.source === b.source) return false
  if (!a.source.includes('announcement') || !b.source.includes('announcement')) return false
  const ta = Date.parse(a.publishedAt)
  const tb = Date.parse(b.publishedAt)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false
  // 东财 display_time（披露时点）与巨潮 announcementTime（日精度 00:00+08）可有数小时偏移，取 ±24h 容差。
  if (Math.abs(ta - tb) > 24 * 3_600_000) return false
  const na = normalizeAnnouncementTitle(a.title)
  const nb = normalizeAnnouncementTitle(b.title)
  if (na.length === 0 || nb.length === 0) return false
  if (na === nb) return true
  const n = Math.min(na.length, nb.length)
  if (n < 8) return false
  let common = 0
  while (common < n && na[common] === nb[common]) common++
  if (common < 6) return false
  // 短边被长边整体覆盖（严格前缀，如 `…报告` vs `…报告摘要`）不判重：无法区分同一文件的两种呈现与两个文件。
  if (na.startsWith(nb) || nb.startsWith(na)) return false
  let suffix = 0
  while (suffix < n - common && na[na.length - 1 - suffix] === nb[nb.length - 1 - suffix]) suffix++
  return suffix >= 2
}

function dedupeCrossSourceAnnouncements(items: NewsItem[]): NewsItem[] {
  const kept: NewsItem[] = []
  for (const item of items) {
    // 先到先得：主源（东财，秒级时间）在 fetcher 序前列出，备份源重复条目被丢弃。
    if (!kept.some((k) => isCrossSourceDup(k, item))) kept.push(item)
  }
  return kept
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
    // 公告双源并行（2026-09-03 多供应商冗余）：东财公告主源 + 巨潮备份源。
    tasks.push(fetchEastmoneyAnnouncements(fetchImpl, options.symbol, limit))
    tasks.push(fetchCninfoAnnouncements(fetchImpl, options.symbol, limit, now))
  }

  const results = await Promise.allSettled(tasks)

  const items: NewsItem[] = []
  const unavailable: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        // 公告放宽时间窗（上市公司公告 7 天内均有效展示），媒体快讯按 24h 时间窗
        const maxAge = item.source.includes('announcement') ? ANNOUNCEMENT_MAX_AGE_MS : windowMs
        if (!inWindow(item.publishedAt, now, maxAge)) continue
        if (!matchesSymbol(item, options.symbol)) continue
        items.push(item)
      }
    } else {
      unavailable.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
    }
  }
  const deduped = dedupeCrossSourceAnnouncements(items)
  deduped.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  return { items: deduped.slice(0, limit), unavailable }
}
