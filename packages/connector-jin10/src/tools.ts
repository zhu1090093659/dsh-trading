/**
 * agent 工具面（市场无关命名，provider 可替换 —— 与 `symbol_search`、`knowledge_search`
 * 同族的跨市场命名，不带交易所名）：快讯、资讯、财经日历、全球品种报价/K线。
 *
 * 输出纪律：
 *   - 列表类工具只回**元数据**（时间/标题/链接/id），正文与摘要正文不下发（数据零再分发）；
 *   - 时间统一 ISO 8601；标题与链接必须可点回原文；
 *   - 分页显式回带 `next_cursor`/`has_more`，让模型能续页而不是猜；
 *   - 上游业务错误（isError / status≠200 / 限流）抛错，绝不静默返回空列表。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Jin10Service } from './service.js'
import { FLASH_PAGE_SIZE, SEARCH_FLASH_MAX } from './service.js'
import { MACRO_CALENDAR_MAX } from './macro-service.js'
import { JIN10_HEAT_LEVELS, isJin10HeatLevel, type Jin10FlashItem, type Jin10HeatLevel } from './web-flash.js'
import type { Jin10RateEntry } from './web-rates.js'
import type { Jin10CalendarEntry, Jin10Instrument, Jin10NewsItem, Jin10NewsPage } from './parse.js'

const textOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const SOURCE = 'Jin10 (金十数据) MCP feed'
/** 热度过滤的实际取数面：金十网页版快讯接口（官方 MCP 的 list_flash 无热度参数）。 */
const HEAT_SOURCE = 'Jin10 (金十数据) web flash endpoint (public heat-filtered feed)'
/** 央行利率的实际取数面：金十日历网页版的公开利率接口，不是官方 MCP feed。 */
const RATES_SOURCE = 'Jin10 (金十数据) web rate board (public interest-rate endpoint behind rili.jin10.com)'

function renderNewsLines(items: readonly (Jin10NewsItem & { id?: string; hot?: string })[]): string[] {
  return items.map((item) => {
    const id = 'id' in item && typeof item.id === 'string' ? ` | id=${item.id}` : ''
    const hot = typeof item.hot === 'string' ? ` | hot=${item.hot}` : ''
    return `${item.publishedAt} | ${item.title} | ${item.url}${id}${hot}`
  })
}

/**
 * `hot` 参数解析（逗号或空白分隔的多值；取值必须是既有热度词汇）。
 * 非法值显式报错并列出支持值——热度过滤是服务端语义，猜一个近义词会静默改变取数范围。
 */
function parseHeatLevels(raw: unknown): Jin10HeatLevel[] {
  if (raw === undefined || raw === null) return []
  const text = typeof raw === 'string' ? raw : String(raw)
  const levels: Jin10HeatLevel[] = []
  for (const token of text.split(/[\s,]+/)) {
    if (token.length === 0) continue
    if (!isJin10HeatLevel(token)) {
      throw new Error(`flash_list: unsupported hot level ${JSON.stringify(token)} (supported: ${JIN10_HEAT_LEVELS.join('/')}; comma-separated for several)`)
    }
    if (!levels.includes(token)) levels.push(token)
  }
  return levels
}

function pageFooter(page: Jin10NewsPage<unknown>, tool: string): string {
  if (page.hasMore && page.nextCursor !== undefined) {
    return `has_more=true — pass cursor="${page.nextCursor}" to ${tool} for the next (older) page.`
  }
  return 'has_more=false — no further pages.'
}

function renderCalendarLine(entry: Jin10CalendarEntry): string {
  const fields = [
    `前值=${entry.previous ?? '-'}`,
    `预期=${entry.consensus ?? '-'}`,
    `公布=${entry.actual ?? '-'}`,
  ]
  if (entry.revised !== undefined) fields.push(`修正=${entry.revised}`)
  if (entry.affect !== undefined) fields.push(`影响=${entry.affect}`)
  return `${entry.publishedAt} | ★${entry.star} | ${entry.title} | ${fields.join(' ')}`
}

/** 工具集合：service 注入即得全部工具（测试用假 service，生产用真 MCP 链路）。 */
export function createJin10Tools(service: Jin10Service): Array<ReturnType<typeof defineTool>> {
  return [
    defineTool({
      name: 'flash_list',
      description:
        `Latest market flash headlines from ${SOURCE}, newest first. Market-wide wire (macro, commodities, FX, A-shares, geopolitics) — not tied to one instrument. `
        + 'Each item carries publish time, headline and the source link; the full flash text stays on the linked page. '
        + `Pages return up to ${FLASH_PAGE_SIZE} items: pass the returned cursor to read older pages. `
        + `Optional hot (comma-separated, values ${JIN10_HEAT_LEVELS.join('/')}) filters server-side by the publisher's heat grade — that path reads ${HEAT_SOURCE} instead of the MCP feed, whose page size is fixed (up to 50 items, no limit parameter), so limit is applied locally to the page and items carry hot=<level>. `
        + 'An upstream error (rate limit, bad token, network) throws instead of returning an empty list — empty output means the upstream really had nothing. '
        + 'Upstream rate limit: 1500 calls per tool per Beijing calendar day.',
      parameters: {
        cursor: { type: 'string', description: 'Opaque page cursor from a previous flash_list call (omit for the newest page)' },
        limit: { type: 'number', description: `Max items to return (integer 1..50; default ${FLASH_PAGE_SIZE})` },
        hot: { type: 'string', description: `Optional heat filter, comma-separated for several: ${JIN10_HEAT_LEVELS.join(' / ')} (火=least, 爆=most); any other value is rejected with the supported list` },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const limit = readLimit(args.limit, FLASH_PAGE_SIZE, 50)
        const cursor = readCursor(args.cursor)
        const hot = parseHeatLevels(args.hot)
        if (hot.length > 0) {
          // 热度过滤走网页版服务端过滤（与 GUI 快讯面板的 hot 参数同一条实现）。
          const page = await service.listFlashByHeat({ hot, ...(cursor !== undefined ? { cursor } : {}) })
          const items: readonly (Jin10FlashItem & { id?: string })[] = page.items.slice(0, limit)
          if (items.length === 0) return `flash_list: no flash items at heat ${hot.join('/')} on this page.`
          return [
            `flash_list (hot=${hot.join('/')}) — ${items.length} item(s) from a fixed ${page.items.length}-item upstream page, newest-first, source: ${HEAT_SOURCE}:`,
            ...renderNewsLines(items),
            pageFooter(page, 'flash_list'),
          ].join('\n')
        }
        const page = await service.listFlash({ limit, ...(cursor !== undefined ? { cursor } : {}) })
        if (page.items.length === 0) return 'flash_list: no flash items returned by the upstream feed.'
        return [
          `flash_list — ${page.items.length} item(s), newest-first, source: ${SOURCE}:`,
          ...renderNewsLines(page.items),
          pageFooter(page, 'flash_list'),
        ].join('\n')
      },
    }),
    defineTool({
      name: 'flash_search',
      description:
        `Keyword search over recent ${SOURCE} flash headlines (e.g. 黄金 / 原油 / 美联储 / 非农 / 日本央行 / 欧佩克). `
        + `Upstream returns at most ${SEARCH_FLASH_MAX} matches in one shot and does not paginate — narrow the keyword instead of paging. `
        + 'Only metadata is returned; open the link for the full text. Upstream rate limit: 1500 calls per tool per Beijing calendar day.',
      parameters: {
        keyword: { type: 'string', required: true as const, description: 'Chinese keyword, e.g. 黄金 / 原油 / 美联储' },
        limit: { type: 'number', description: `Max matches to return (integer 1..${SEARCH_FLASH_MAX}; default 30)` },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const limit = readLimit(args.limit, 30, SEARCH_FLASH_MAX)
        const items = await service.searchFlash(String(args.keyword ?? ''), limit)
        if (items.length === 0) return `flash_search: no flash items matched ${JSON.stringify(String(args.keyword ?? ''))}.`
        return [
          `flash_search — ${items.length} match(es) for ${JSON.stringify(String(args.keyword ?? ''))}, newest-first, source: ${SOURCE}:`,
          ...renderNewsLines(items),
        ].join('\n')
      },
    }),
    defineTool({
      name: 'news_list',
      description:
        `Latest ${SOURCE} editorial articles (longer-form macro/market analysis), newest first. Articles are paged: pass the returned cursor for older pages. `
        + 'Returns metadata plus the article id; call news_get with that id for the publisher abstract. Upstream rate limit: 1500 calls per tool per Beijing calendar day.',
      parameters: {
        cursor: { type: 'string', description: 'Opaque page cursor from a previous news_list call (omit for the newest page)' },
        limit: { type: 'number', description: 'Max items to return (integer 1..50; default 10)' },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const limit = readLimit(args.limit, 10, 50)
        const cursor = readCursor(args.cursor)
        const page = await service.listNews({ limit, ...(cursor !== undefined ? { cursor } : {}) })
        if (page.items.length === 0) return 'news_list: no articles returned by the upstream feed.'
        return [
          `news_list — ${page.items.length} article(s), newest-first, source: ${SOURCE}:`,
          ...renderNewsLines(page.items),
          pageFooter(page, 'news_list'),
        ].join('\n')
      },
    }),
    defineTool({
      name: 'news_search',
      description:
        `Keyword search over ${SOURCE} editorial articles (e.g. 美联储 / 通胀 / 欧佩克 / 日元). Paged like news_list; each hit carries an id for news_get. `
        + 'Metadata only — the article body stays on the publisher page. Upstream rate limit: 1500 calls per tool per Beijing calendar day.',
      parameters: {
        keyword: { type: 'string', required: true as const, description: 'Chinese keyword, e.g. 美联储 / 通胀 / 日元' },
        cursor: { type: 'string', description: 'Opaque page cursor from a previous news_search call' },
        limit: { type: 'number', description: 'Max matches to return (integer 1..50; default 10)' },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const limit = readLimit(args.limit, 10, 50)
        const cursor = readCursor(args.cursor)
        const page = await service.searchNews(String(args.keyword ?? ''), { limit, ...(cursor !== undefined ? { cursor } : {}) })
        if (page.items.length === 0) return `news_search: no articles matched ${JSON.stringify(String(args.keyword ?? ''))}.`
        return [
          `news_search — ${page.items.length} match(es) for ${JSON.stringify(String(args.keyword ?? ''))}, newest-first, source: ${SOURCE}:`,
          ...renderNewsLines(page.items),
          pageFooter(page, 'news_search'),
        ].join('\n')
      },
    }),
    defineTool({
      name: 'news_get',
      description:
        `Publisher metadata for one ${SOURCE} article: title, publish time, link and the publisher's own introduction/abstract, by article id from news_list or news_search. `
        + 'The full article body is not redistributed — open the link to read it. Upstream rate limit: 1500 calls per tool per Beijing calendar day.',
      parameters: {
        id: { type: 'string', required: true as const, description: 'Article id from news_list / news_search, e.g. 229952' },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const article = await service.getArticle(String(args.id ?? ''))
        return [
          `news_get — id=${article.id}, source: ${SOURCE}`,
          `title: ${article.title}`,
          `publishedAt: ${article.publishedAt}`,
          `url: ${article.url}`,
          ...(article.introduction !== undefined ? [`introduction: ${article.introduction}`] : []),
        ].join('\n')
      },
    }),
    defineTool({
      name: 'econ_calendar',
      description:
        `Current-week economic calendar from ${SOURCE} (Monday–Sunday, Beijing time): release time, importance stars, consensus / previous / actual values and the stated market impact. `
        + 'Values are the publisher snapshot as of the call — the same release may be revised; treat actual=null as "not published yet". '
        + 'Upstream rate limit: 1500 calls per tool per Beijing calendar day.',
      parameters: {
        limit: { type: 'number', description: `Max entries to return (integer 1..${MACRO_CALENDAR_MAX}; default 40, earliest first)` },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const limit = readLimit(args.limit, 40, MACRO_CALENDAR_MAX)
        const entries = await service.listCalendar(limit)
        if (entries.length === 0) return 'econ_calendar: the upstream calendar is empty for the current week.'
        return [
          `econ_calendar — ${entries.length} entr(ies) for the current week (Beijing time), source: ${SOURCE}:`,
          ...entries.map(renderCalendarLine),
        ].join('\n')
      },
    }),
    defineTool({
      name: 'macro_rates',
      description:
        `Latest policy interest rate for every central bank on the ${RATES_SOURCE} (~30 banks: Fed, ECB, BOJ, PBoC, BoE …), one row per bank with the publication date of that rate. `
        + 'Units: percent per year (the publisher\'s own string, e.g. "3.75" or "0"; never converted to a decimal fraction and never recomputed). '
        + 'Time basis: the endpoint is a latest-value snapshot and declares no snapshot timestamp, so each row carries its own publishedAt and as_of is this call\'s time — check the call time, not the value alone. '
        + 'Optional region filters on the publisher\'s own region label (e.g. 美国 / 欧元区 / 中国); a filter that matches nothing returns an empty list plus available_regions. '
        + 'An upstream failure (HTTP error, non-JSON body, publisher status != 200) throws — an empty list never stands in for "the endpoint is down". '
        + 'No Jin10 MCP token is needed for this reading.',
      parameters: {
        region: { type: 'string', description: 'Optional exact region label from the publisher vocabulary, e.g. 美国 / 欧元区 / 日本 / 中国 (omit for all banks)' },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const region = typeof args.region === 'string' && args.region.trim().length > 0 ? args.region.trim() : undefined
        const all = await service.listRates()
        const items: readonly Jin10RateEntry[] = region === undefined ? all : all.filter(entry => entry.region === region)
        const regions = [...new Set(all.map(entry => entry.region).filter(value => value.length > 0))].sort()
        return JSON.stringify({
          source: RATES_SOURCE,
          unit: 'percent per year (publisher raw string)',
          as_of: new Date().toISOString(),
          snapshot_at: null,
          snapshot_note: 'The publisher returns a latest-value snapshot with no snapshot timestamp in the contract; each row carries its own publishedAt (publication date of that rate).',
          region: region ?? null,
          available_regions: regions,
          total: all.length,
          count: items.length,
          items,
        })
      },
    }),
    defineTool({
      name: 'global_instruments',
      description:
        `Code catalog for the ${SOURCE} quote space (spot metals, energy, FX, global and A-share indices). `
        + 'Call this before global_quote / global_klines whenever the code is not obvious; codes are the publisher\'s own (XAUUSD, USOIL, USBND, USDJPY …), NOT the market symbol vocabulary. '
        + 'Upstream rate limit: 1500 calls per tool per Beijing calendar day.',
      parameters: {
        query: { type: 'string', description: 'Optional filter on code or Chinese name, e.g. 黄金 / 原油 / JPY' },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const query = typeof args.query === 'string' && args.query.trim().length > 0 ? args.query.trim() : undefined
        const items = await service.listInstruments(query)
        const label = query === undefined ? 'all instruments' : `matches for ${JSON.stringify(query)}`
        if (items.length === 0) return `global_instruments: no ${label} in the quote space.`
        return [
          `global_instruments — ${items.length} ${label} (source: ${SOURCE}):`,
          ...items.map((item: Jin10Instrument) => `${item.code} — ${item.name}`),
        ].join('\n')
      },
    }),
    defineTool({
      name: 'global_quote',
      description:
        `Real-time quote for one ${SOURCE} instrument (spot gold/silver/copper, WTI/Brent, FX, indices). `
        + 'Fields: open/close/high/low/volume plus change and change percent; `time` is the quote timestamp (Beijing time) — quotes may be delayed or closed-market. '
        + 'Use global_instruments to resolve a code. Upstream rate limit: 1500 calls per tool per Beijing calendar day.',
      parameters: {
        code: { type: 'string', required: true as const, description: 'Publisher code, e.g. XAUUSD / XAGUSD / USOIL / UKOIL / COPPER / USDJPY / EURUSD / USDCNH' },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const quote = await service.getQuote(String(args.code ?? ''))
        return JSON.stringify(quote)
      },
    }),
    defineTool({
      name: 'global_klines',
      description:
        `Minute-level candles for one ${SOURCE} instrument. \`time\` is the START Unix timestamp in seconds; candles return forward from it within a 24-hour window `
        + '(omit it and the window starts at the current minute, often returning an empty result — pass a start inside the last 24h). '
        + 'count is 1..100 (default 100). An empty array means no candles in that window (closed market/weekend), not an upstream failure. '
        + 'Rate limit: 1500 calls per tool per Beijing day.',
      parameters: {
        code: { type: 'string', required: true as const, description: 'Publisher code, e.g. XAUUSD / USOIL / USDJPY' },
        time: { type: 'number', description: 'Start Unix timestamp in seconds (from the last 24 hours)' },
        count: { type: 'number', description: 'Number of candles from time, integer 1..100 (default 100)' },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const code = String(args.code ?? '')
        const options: { time?: number; count?: number } = {}
        if (args.time !== undefined) options.time = Math.floor(Number(args.time))
        if (args.count !== undefined) options.count = Math.floor(Number(args.count))
        const klines = await service.getKlines(code, options)
        if (klines.length === 0) return JSON.stringify({ code, klines: [], note: 'no candles in the requested window (upstream returns forward from time, 24h window)' })
        return JSON.stringify({ code, klines })
      },
    }),
  ]
}

function readLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function readCursor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
