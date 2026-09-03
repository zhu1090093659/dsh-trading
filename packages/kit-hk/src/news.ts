/**
 * hk_get_news 取数层（WS4 #1：#6 子工作流；spike EVIDENCE 判定 hk 无干净公共源 → 采用「降级」方案）。
 *
 * 降级口径（用户裁决 2026-08-30）：用东方财富快讯第 103 列（「港股」列，但实为统一 CN 金融流、覆盖不纯），
 * 客户端按 `stockList` 中的**港交所 marketId=116** 代码 + 标题港股关键词过滤出港股相关标的新闻。诚实标注：
 * 覆盖**部分**（港股新闻若不带港股关联代码/关键词则不捕获），非专用港股新闻源；与 CryptoPanic 的降级同理。
 *
 * 公告双源（2026-09-03，多供应商冗余裁决；spikes/impl-hk-cn-announce-sources/ EVIDENCE）：
 * 东财 ann_type=H（主源，秒级时间）+ HKEX 披露易 titleSearchServlet（备份源），allSettled 并行 +
 * 跨源去重（归一化标题共同前缀 ≥6 字且 ±24h 内视为同一条披露，繁体经映射表转简体后比对）。
 *
 * 铁律 #5：只引 title/showTime/链接（元数据），不取 summary/正文，不再分发。每源失败 fail-soft。
 */
export type NewsSource = 'eastmoney' | 'eastmoney-announcement' | 'hkex-announcement'

export interface NewsItem {
  source: string
  title: string
  url: string
  publishedAt: string
  relatedCodes?: string[]
}

export interface AggregateNewsOptions {
  /** 标的（市场规范词汇，如 00700 / 00700.HK / 0700）；缺省 = 不过滤。 */
  symbol?: string | undefined
  windowHours?: number | undefined
  limit?: number | undefined
  fetch?: typeof globalThis.fetch | undefined
  now?: number | undefined
  /** CryptoPanic API token（桥面透传，hk 聚合器忽略；对齐 api 契约形状）。 */
  cryptoPanicKey?: string | undefined
}

export interface AggregateNewsResult {
  items: NewsItem[]
  unavailable: string[]
}

const EASTMONEY_URL = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList'
const HKEX_BASE = 'https://www1.hkexnews.hk'
const DEFAULT_WINDOW_HOURS = 24
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (dsh-trading/hk_get_news)'
/** 下钻 fetch 统一 10s 超时（docs/replication.md §9；上游挂起不得拖垮 60s 轮询链）。 */
const UPSTREAM_TIMEOUT_MS = 10_000
/** 港交所 marketId（stockList 前缀，如 '116.00700'）。 */
const HK_MARKET_ID = '116.'
/** 港股关键词（无关联代码时仍判为港股相关）。 */
const HK_KEYWORDS = ['港股', '港交所', '香港', '恒指', '恒生']
/** 公告放宽时间窗：上市公司公告 7 天内有效展示（媒体快讯仍按 24h 窗）。 */
const ANNOUNCEMENT_MAX_AGE_MS = 7 * 24 * 3_600_000
/** HKEX 公告检索请求窗：宽于 7 天过滤窗，避免时区/日期边界裁剪（DATE_TIME 港图时间）。 */
const HKEX_REQUEST_WINDOW_MS = 14 * 24 * 3_600_000

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

async function fetchEastmoneyHkAnnouncements(fetchImpl: typeof globalThis.fetch, rawSymbol: string, limit: number): Promise<NewsItem[]> {
  const clean = rawSymbol.trim().replace(/\.HK$/i, '').padStart(5, '0')
  if (!/^\d{5}$/.test(clean)) return []
  const url = new URL('https://np-anotice-stock.eastmoney.com/api/security/ann')
  url.searchParams.set('page_size', String(Math.max(limit, 20)))
  url.searchParams.set('page_index', '1')
  url.searchParams.set('ann_type', 'H')
  url.searchParams.set('client_source', 'web')
  url.searchParams.set('stock_list', clean)
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`eastmoney-announcement: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
  }
  const parsed: unknown = JSON.parse(await response.text())
  const list = (parsed as { data?: { list?: Array<{ art_code?: string; title_ch?: string; title?: string; display_time?: string; notice_date?: string }> } }).data?.list
  if (!Array.isArray(list)) throw new Error('eastmoney-announcement: unexpected payload (expected data.list[])')
  const items: NewsItem[] = []
  for (const it of list) {
    const title = it.title_ch || it.title
    if (!title || !it.art_code) continue
    const timeStr = it.display_time || it.notice_date || ''
    const ts = parseHkShowTime(timeStr.slice(0, 19))
    // 解析失败丢弃该条，绝不回退「现在」——虚假新鲜事件会恒过时间窗并钉到最新 K 线。
    if (!Number.isFinite(ts)) continue
    items.push({
      source: 'eastmoney-announcement',
      title,
      url: `https://data.eastmoney.com/notices/detail/${clean}/${encodeURIComponent(it.art_code)}.html`,
      publishedAt: new Date(ts).toISOString(),
      relatedCodes: [`116.${clean}`],
    })
  }
  return items
}

/* -- HKEX 披露易公告源（spikes/impl-hk-cn-announce-sources/ EVIDENCE，A 级）-- */

/**
 * 股票代码 → HKEX stockId 内码 memo。prefix.do 冷请求 ~3.7s，stockId 是稳定静态
 * 映射（kit 层参考数据，非行情缓存，不违铁律 #5 桥无状态语义）；仅缓存成功值。
 */
const hkexStockIdMemo = new Map<string, number>()

/** 清空 HKEX stockId memo（单测隔离用；生产运行期不需要调用）。 */
export function resetHkexAnnouncementMemo(): void {
  hkexStockIdMemo.clear()
}

/** HKEX 披露易 DATE_TIME：`DD/MM/YYYY HH:MM`（日/月倒序，港图时间东八区）→ 毫秒。 */
export function parseHkexDateTime(value: string): number {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(value.trim())
  if (m === null) return NaN
  const t = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+08:00`)
  return Number.isFinite(t) ? t : NaN
}

interface HkexTitleRow {
  TITLE?: string
  DATE_TIME?: string
  FILE_LINK?: string
  STOCK_CODE?: string
}

async function fetchHkexStockId(fetchImpl: typeof globalThis.fetch, code: string): Promise<number> {
  const cached = hkexStockIdMemo.get(code)
  if (cached !== undefined) return cached
  const url = new URL(`${HKEX_BASE}/search/prefix.do`)
  url.searchParams.set('callback', 'callback')
  url.searchParams.set('lang', 'ZH')
  url.searchParams.set('type', 'A')
  url.searchParams.set('name', code)
  url.searchParams.set('market', 'SEHK')
  const response = await fetchImpl(url, { headers: { accept: '*/*', 'user-agent': UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`hkex: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
  }
  // JSONP：callback({...}) → 剥壳取 stockId；优先精确匹配 code，退化取首条。
  const parsed: unknown = JSON.parse((await response.text()).replace(/^callback\(/, '').replace(/\);\s*$/, ''))
  const list = (parsed as { stockInfo?: Array<{ stockId?: number; code?: string }> }).stockInfo
  const hit = Array.isArray(list)
    ? (list.find((it) => it.code === code) ?? list[0])
    : undefined
  if (typeof hit?.stockId !== 'number') throw new Error('hkex: unexpected payload (expected stockInfo[].stockId)')
  hkexStockIdMemo.set(code, hit.stockId)
  return hit.stockId
}

async function fetchHkexAnnouncements(fetchImpl: typeof globalThis.fetch, rawSymbol: string, limit: number): Promise<NewsItem[]> {
  const clean = rawSymbol.trim().replace(/\.HK$/i, '').padStart(5, '0')
  if (!/^\d{5}$/.test(clean)) return []
  const stockId = await fetchHkexStockId(fetchImpl, clean)
  const now = Date.now()
  const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')
  const url = new URL(`${HKEX_BASE}/search/titleSearchServlet.do`)
  url.searchParams.set('sortDir', '0')
  url.searchParams.set('sortByOptions', 'DateTime')
  url.searchParams.set('category', '0')
  url.searchParams.set('market', 'SEHK')
  url.searchParams.set('stockId', String(stockId))
  url.searchParams.set('documentType', '-1')
  url.searchParams.set('fromDate', ymd(now - HKEX_REQUEST_WINDOW_MS))
  url.searchParams.set('toDate', ymd(now))
  url.searchParams.set('title', '')
  url.searchParams.set('searchType', '1')
  url.searchParams.set('t1code', '-2')
  url.searchParams.set('t2Gcode', '-2')
  url.searchParams.set('t2code', '-2')
  url.searchParams.set('rowRange', String(Math.max(limit, 20)))
  url.searchParams.set('lang', 'ZH')
  const response = await fetchImpl(url, { headers: { accept: '*/*', 'user-agent': UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`hkex-announcement: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
  }
  const parsed: unknown = JSON.parse(await response.text())
  // 外层 JSON 的 result 是 JSON 编码的字符串，需二次 parse（spike EVIDENCE 解析坑）。
  const result = (parsed as { result?: string | unknown[] }).result
  const rows: unknown[] = typeof result === 'string'
    ? JSON.parse(result)
    : Array.isArray(result) ? result : []
  if (!Array.isArray(rows)) throw new Error('hkex-announcement: unexpected payload (expected result[])')
  const items: NewsItem[] = []
  for (const row of rows as HkexTitleRow[]) {
    if (!row.TITLE || !row.FILE_LINK) continue
    const ts = parseHkexDateTime(row.DATE_TIME ?? '')
    // 解析失败丢弃该条，绝不回退「现在」——虚假新鲜事件会恒过时间窗并钉到最新 K 线。
    if (!Number.isFinite(ts)) continue
    items.push({
      source: 'hkex-announcement',
      title: row.TITLE,
      url: `${HKEX_BASE}${row.FILE_LINK}`,
      publishedAt: new Date(ts).toISOString(),
      relatedCodes: [`116.${clean}`],
    })
  }
  return items
}

/* -- 跨源公告去重（东财 ↔ HKEX 同一条披露会同时出现，不去重则公告页签/图钉成对假事件）-- */

/** 繁→简映射（HKEX 标题为繁体、东财转简体）：仅覆盖公告标题高频字，缺字即原样保留。 */
const TRAD_TO_SIMP: Record<string, string> = {
  報: '报', 變: '变', 動: '动', 購: '购', 會: '会', 業: '业', 資: '资', 訊: '讯', 關: '关', 聯: '联',
  營: '营', 運: '运', 財: '财', 務: '务', 長: '长', 開: '开', 東: '东', 門: '门', 項: '项', 證: '证',
  淨: '净', 虧: '亏', 損: '损', 積: '积', 極: '极', 環: '环', 場: '场', 標: '标', 題: '题', 續: '续',
  職: '职', 執: '执', 導: '导', 師: '师', 顧: '顾', 問: '问', 講: '讲', 評: '评', 議: '议', 決: '决',
  賠: '赔', 償: '偿', 質: '质', 貸: '贷', 結: '结', 費: '费', 訂: '订', 閱: '阅', 億: '亿', 兩: '两',
  廣: '广', 廠: '厂', 銀: '银', 聲: '声', 識: '识', 體: '体', 總: '总', 經: '经', 銷: '销', 產: '产',
  賣: '卖', 買: '买', 賬: '账', 戶: '户', 權: '权', 讓: '让', 擔: '担', 託: '托', 約: '约', 訴: '诉',
  訟: '讼', 詢: '询', 復: '复', 對: '对', 審: '审', 計: '计', 備: '备', 稅: '税', 應: '应', 鏈: '链',
  儲: '储', 據: '据', 領: '领', 補: '补', 貼: '贴', 凍: '冻', 註: '注', 績: '绩', 預: '预', 減: '减',
  轉: '转', 離: '离', 辭: '辞', 選: '选', 舉: '举', 臨: '临', 時: '时', 間: '间', 規: '规', 則: '则',
  範: '范', 貨: '货', 價: '价', 錄: '录', 屬: '属', 區: '区', 歲: '岁', 萬: '万', 與: '与',
  內: '内', 實: '实', 濟: '济', 狀: '状', 況: '况', 顯: '显', 釋: '释', 說: '说', 詳: '详',
  壓: '压', 風: '风', 險: '险', 靈: '灵', 遠: '远', 遜: '逊', 達: '达', 遲: '迟',
  劃: '划', 歷: '历', 歸: '归', 當: '当', 鐘: '钟', 頭: '头', 發: '发', 電: '电', 龍: '龙',
}

/**
 * 公告标题归一化：去公司名前缀（东财习惯 `公司:标题`）→ 繁转简 → 去全部标点/符号/空白。
 * 归一化后跨源比对（同源不去重：同日两份同名披露是合法的不同文件）。
 */
function normalizeAnnouncementTitle(title: string): string {
  const stripped = title.replace(/^[^：:]*[：:]\s*/, '')
  let converted = ''
  for (const ch of stripped) converted += TRAD_TO_SIMP[ch] ?? ch
  return converted.replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 公告标题以类别开头（翌日披露报表/中期报告…），繁简转换与括注差异使全文等值不可靠；归一化后共同前缀 ≥6 字视为同类别。 */
function isCrossSourceDup(a: NewsItem, b: NewsItem): boolean {
  if (a.source === b.source) return false
  if (!a.source.includes('announcement') || !b.source.includes('announcement')) return false
  const ta = Date.parse(a.publishedAt)
  const tb = Date.parse(b.publishedAt)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false
  // 东财 display_time（披露时点）与 HKEX DATE_TIME（文件时间）可有数小时偏移，取 ±24h 容差。
  if (Math.abs(ta - tb) > 24 * 3_600_000) return false
  const na = normalizeAnnouncementTitle(a.title)
  const nb = normalizeAnnouncementTitle(b.title)
  if (na.length === 0 || nb.length === 0) return false
  if (na === nb) return true
  const n = Math.min(na.length, nb.length)
  let common = 0
  while (common < n && na[common] === nb[common]) common++
  return common >= 6
}

function dedupeCrossSourceAnnouncements(items: NewsItem[]): NewsItem[] {
  const kept: NewsItem[] = []
  for (const item of items) {
    // 先到先得：主源（东财，秒级时间）在 fetcher 序前列出，备份源重复条目被丢弃。
    if (!kept.some((k) => isCrossSourceDup(k, item))) kept.push(item)
  }
  return kept
}

export async function aggregateNews(options: AggregateNewsOptions = {}): Promise<AggregateNewsResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now()
  const windowHours = clampNumber(options.windowHours, DEFAULT_WINDOW_HOURS, 1, 24 * 7)
  const windowMs = windowHours * 3_600_000
  const limit = clampNumber(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)

  const fetchers: Promise<NewsItem[]>[] = [fetchEastmoneyHk(fetchImpl, limit)]
  if (options.symbol && options.symbol.trim()) {
    // 公告双源并行（2026-09-03 多供应商冗余）：东财 ann_type=H 主源 + HKEX 披露易备份源。
    fetchers.push(fetchEastmoneyHkAnnouncements(fetchImpl, options.symbol, limit))
    fetchers.push(fetchHkexAnnouncements(fetchImpl, options.symbol, limit))
  }

  const results = await Promise.allSettled(fetchers)

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
