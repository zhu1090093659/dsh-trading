/**
 * crypto_get_news 取数层（WS2b，#3 spike 推荐：kit 内薄工具，直连公共源，无连接器服务）。
 *
 * 四源全为单端点、无鉴权、无状态的公共 GET（见 spikes/impl-crypto-news/EVIDENCE.md 分级总表）：
 *   - Binance 公告 CMS（GET 变体；POST 403 勿走）——JSON，链接由 code 构造
 *   - OKX v5 support/announcements ——JSON，条目自带直链
 *   - CoinDesk / The Block RSS   ——RSS 2.0
 * 本模块只做取数 + 归一化为 NewsItem[]，时间窗/币种过滤 + 排序截尾；defineTool 装配在 index.ts。
 *
 * 铁律 #5：输出只带元数据（来源名/标题/链接/发布时间），不取正文，不缓存，不再分发。
 * 每源独立容错：单源失败不炸整体，失败源在 `unavailable` 中注明（工具输出可见），fail-soft。
 */
/** 已接入的新闻来源（EVIDENCE 分级总表：A 级打底/媒体面 + B 级 CryptoPanic 自备 key）。 */
export type NewsSource = 'binance' | 'okx' | 'coindesk' | 'theblock' | 'cryptopanic'

export interface NewsItem {
  /** 来源名（铁律 #5 的来源标注；同时是「引用给 Agent 可以、再分发不行」的边界提醒落点）。 */
  source: NewsSource
  title: string
  url: string
  /** ISO 8601 发布时间。 */
  publishedAt: string
}

export interface AggregateNewsOptions {
  /** 币种过滤（市场规范词汇，如 BTCUSDT / BTCUSDT-SWAP）；缺省 = 不过滤。 */
  symbol?: string
  /** 时间窗（小时）：只保留 now - windowHours 内的条目；缺省 24。 */
  windowHours?: number
  /** 输出条数上限；缺省 20。 */
  limit?: number
  /** 依赖注入的 fetch（测试用 mock；缺省 globalThis.fetch）。 */
  fetch?: typeof globalThis.fetch
  /** 注入当前时间戳（ms，测试用）；缺省 Date.now()。 */
  now?: number
  /** WS2c：CryptoPanic API token。有值时加测 CryptoPanic 免费层（B 增强）；无值 = 仅公共源。 */
  cryptoPanicKey?: string
}

export interface AggregateNewsResult {
  items: NewsItem[]
  /** 取数失败的源：`<匿名>`（如 'binance: HTTP 500 — ...'），工具输出需注明缺席。 */
  unavailable: string[]
}

/** 交易相关 Binance 公告分类（EVIDENCE：48 新币上市 / 161 下架 / 51 API 更新 / 157 维护）。 */
const BINANCE_NEWS_CATALOGS = new Set([48, 161, 51, 157])
const DSHTRADING_API = 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query'
const OKX_ANNOUNCEMENT_URL = 'https://www.okx.com/api/v5/support/announcements'
const COINDESK_RSS_URL = 'https://www.coindesk.com/arc/outboundfeeds/rss/'
const THEBLOCK_RSS_URL = 'https://www.theblock.co/rss.xml'
const CRYPTOPANIC_API_URL = 'https://cryptopanic.com/api/free/v1/posts/'

const DEFAULT_WINDOW_HOURS = 24
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

const BINANCE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (dsh-trading/crypto_get_news)'

/* ── 通用 fetch 助手（带错误注入，供单源容错与测试） ─────────────────────────── */

async function fetchText(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  fetcherName: string,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json, text/xml, */*', 'user-agent': BINANCE_UA },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${fetcherName}: HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`)
  }
  return response.text()
}

/* ── Binance 公告 CMS（JSON；url 由 code 构造） ─────────────────────────────── */

interface BinanceArticle {
  id?: number
  code?: string
  title?: string
  releaseDate?: number
}

async function fetchBinanceNews(fetchImpl: typeof globalThis.fetch): Promise<NewsItem[]> {
  // 必带分页/类型参数（EVIDENCE：裸 URL 返 HTTP 400 illegal parameter；type=1 公告面）。
  const url = new URL(DSHTRADING_API)
  url.searchParams.set('type', '1')
  url.searchParams.set('pageNo', '1')
  url.searchParams.set('pageSize', '20')
  const text = await fetchText(url.toString(), fetchImpl, 'binance')
  const parsed: unknown = JSON.parse(text)
  const data = (parsed as { data?: { catalogs?: Array<{ catalogId?: number; articles?: BinanceArticle[] }> } }).data
  const catalogs = data?.catalogs
  if (!Array.isArray(catalogs)) throw new Error('binance: unexpected payload (expected data.catalogs[])')
  const items: NewsItem[] = []
  for (const catalog of catalogs) {
    if (catalog?.catalogId != null && !BINANCE_NEWS_CATALOGS.has(catalog.catalogId)) continue
    for (const article of catalog?.articles ?? []) {
      const code = article.code
      if (!article.title || !code) continue
      const ts = article.releaseDate
      if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
      items.push({
        source: 'binance',
        title: article.title,
        url: `https://www.binance.com/en/support/announcement/${encodeURIComponent(code)}`,
        publishedAt: new Date(ts).toISOString(),
      })
      // 每个 catalog 首屏 20 条已足够覆盖时间窗，防止无关分类膨胀。
      if (items.length >= 60) break
    }
    if (items.length >= 60) break
  }
  return items
}

/* ── OKX announcements（JSON；条目自带直链） ────────────────────────────────── */

interface OkxAnnouncement {
  title?: string
  url?: string
  pTime?: string
  annType?: string
}

async function fetchOkxNews(fetchImpl: typeof globalThis.fetch): Promise<NewsItem[]> {
  const text = await fetchText(OKX_ANNOUNCEMENT_URL, fetchImpl, 'okx')
  const parsed: unknown = JSON.parse(text)
  const data = (parsed as { data?: Array<{ details?: OkxAnnouncement[] }> }).data
  const details = data?.[0]?.details
  if (!Array.isArray(details)) throw new Error('okx: unexpected payload (expected data[0].details[])')
  const items: NewsItem[] = []
  for (const a of details) {
    if (!a.title || !a.url) continue
    const ts = Number(a.pTime)
    if (!Number.isFinite(ts)) continue
    items.push({
      source: 'okx',
      title: a.title,
      url: a.url,
      publishedAt: new Date(ts).toISOString(),
    })
  }
  return items
}

/* ── RSS 2.0 解析（CoinDesk / The Block 同构；不引 XML 依赖） ────────────────── */

function decodeXmlText(raw: string): string {
  // 剥 CDATA 包裹 → 解实体（含 &#xN; / &#N;）。
  const out = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, m) => m)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  return out.trim()
}

/** 取某个 item 块内首个指定标签的文本（支持 CDATA 与实体；无标签返回 ''）。 */
function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'i')
  const match = block.match(re)
  if (!match) return ''
  return decodeXmlText(match[0].replace(new RegExp(`<\\/?${tag}[^>]*>`, 'gi'), ''))
}

export function parseRss2(xml: string, source: NewsSource): NewsItem[] {
  const items: NewsItem[] = []
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []
  for (const block of blocks) {
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link')
    if (!title || !link) continue
    const pubDate = extractTag(block, 'pubDate')
    const ts = Date.parse(pubDate)
    if (!Number.isFinite(ts)) continue
    items.push({ source, title, url: link, publishedAt: new Date(ts).toISOString() })
  }
  return items
}

async function fetchRssNews(fetchImpl: typeof globalThis.fetch, source: NewsSource, url: string): Promise<NewsItem[]> {
  const text = await fetchText(url, fetchImpl, source)
  return parseRss2(text, source)
}

/* ── CryptoPanic 免费层（WS2c B 增强；用户自备 key，无 key 或失败即降级） ───────── */

interface CryptoPanicPost {
  title?: string
  url?: string
  published_at?: string
  currency?: string
}

/** 解析 CryptoPanic { results:[...] }（公开 free API 响应形）。 */
export function parseCryptoPanic(data: unknown): NewsItem[] {
  const results = (data as { results?: CryptoPanicPost[] }).results
  if (!Array.isArray(results)) throw new Error('cryptopanic: unexpected payload (expected results[])')
  const items: NewsItem[] = []
  for (const post of results) {
    if (!post.title || !post.url) continue
    const ts = Date.parse(post.published_at ?? '')
    if (!Number.isFinite(ts)) continue
    items.push({ source: 'cryptopanic', title: post.title, url: post.url, publishedAt: new Date(ts).toISOString() })
  }
  return items
}

async function fetchCryptoPanicNews(fetchImpl: typeof globalThis.fetch, key: string, currencies: string): Promise<NewsItem[]> {
  const url = new URL(CRYPTOPANIC_API_URL)
  url.searchParams.set('auth_token', key)
  if (currencies) url.searchParams.set('currencies', currencies)
  const text = await fetchText(url.toString(), fetchImpl, 'cryptopanic')
  return parseCryptoPanic(JSON.parse(text))
}

/* ── 聚合：并发取四源 → 时间窗/币种过滤 → 按时间倒序 → 截尾 ──────────────────── */

/** 币种过滤 token 派生：剥离常见报价/后缀（BTCUSDT-SWAP → [BTCUSDT-SWAP, BTC]）。 */
export function deriveSymbolTokens(symbol?: string): string[] {
  const raw = symbol?.trim().toUpperCase() ?? ''
  if (!raw) return []
  let base = raw.replace(/[-_](?:SWAP|PERP|FUTURES|DEFAULT)$/i, '')
  base = base.replace(/(?:USDT|USDC|BUSD|FDUSD|USD)$/i, '')
  return [...new Set([raw, base])].filter(Boolean)
}

function inWindow(publishedAt: string, nowMs: number, windowMs: number): boolean {
  const ts = Date.parse(publishedAt)
  if (!Number.isFinite(ts)) return false
  return ts >= nowMs - windowMs && ts <= nowMs + 60_000 // 允许 1 分钟时钟误差
}

function matchesSymbol(item: NewsItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const title = item.title.toUpperCase()
  return tokens.some((t) => title.includes(t))
}

export async function aggregateNews(options: AggregateNewsOptions = {}): Promise<AggregateNewsResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now()
  const windowHours = clampNumber(options.windowHours, DEFAULT_WINDOW_HOURS, 1, 24 * 7)
  const windowMs = windowHours * 3_600_000
  const limit = clampNumber(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  const tokens = deriveSymbolTokens(options.symbol)

  // WS2c：有 key 时加测 CryptoPanic 免费层（B 增强）；无 key 仅公共源。
  // cryptopanic 失败不炸整体——落入 allSettled 的 rejected 分支 → unavailable（降级语义）。
  const fetchers: Promise<NewsItem[]>[] = [
    fetchBinanceNews(fetchImpl),
    fetchOkxNews(fetchImpl),
    fetchRssNews(fetchImpl, 'coindesk', COINDESK_RSS_URL),
    fetchRssNews(fetchImpl, 'theblock', THEBLOCK_RSS_URL),
  ]
  if (options.cryptoPanicKey && options.cryptoPanicKey.trim()) {
    // CryptoPanic currencies 参数用币种代码（BTC/ETH/SOL，不含报价后缀）。
    const currencies = [...new Set(tokens.map((t) => t.replace(/(?:USDT|USDC|BUSD|FDUSD|USD)$/i, '')))].filter(Boolean).join(',')
    fetchers.push(fetchCryptoPanicNews(fetchImpl, options.cryptoPanicKey.trim(), currencies))
  }

  const results = await Promise.allSettled(fetchers)

  const items: NewsItem[] = []
  const unavailable: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        if (!inWindow(item.publishedAt, now, windowMs)) continue
        if (!matchesSymbol(item, tokens)) continue
        items.push(item)
      }
    } else {
      unavailable.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
    }
  }

  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  return { items: items.slice(0, limit), unavailable }
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}
