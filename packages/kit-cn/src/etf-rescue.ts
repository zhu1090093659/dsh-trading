/**
 * @dshtrading/connector-akshare/etf-rescue
 * 「ETF 托底」纯函数面：白名单解析、五个上游响应的解析、规模/深度/广度计算。
 *
 * 本模块不触网、不碰文件系统（xlsx 解压是对字节的纯计算），全部可单测：
 * 解析与网络的分层照本包 rest.ts 的既有风格（纯解析 + 独立网络模块）。
 *
 * 口径（三路冻结，源自 packages/api 的 EtfRescuePoint / EtfRescueHistory）：
 *   规模_etf,t = 份额_etf,t（份）× 单位净值_etf,t（元/份）   → 元
 *   深度_t     = Σ规模(该指数篮子) ÷ 流通市值(该指数) × 100
 *   广度_t     = Σ规模(非300 六个篮子) ÷ Σ流通市值(那六个指数) × 100
 *   流通市值_指数,t = k_指数 × close_指数,t（k 由东财 f117 ÷ f43 标定后长缓存）
 * 空 ≠ 0：缺份额或缺净值的 ETF 当日不参与合计；全部 ETF 都不可得则该日不出点。
 */

import type { EtfRescuePoint } from '@dshtrading/api'
import { unzipSync } from 'fflate'

/** 回溯起点（冻结）；更早的份额不取，缓存里的更早日期也不出点。 */
export const ETF_RESCUE_START_DATE = '2023-01-01'

/** 沪深300 指数：广度口径里唯一被排除的那个篮子（冻结）。 */
export const ETF_RESCUE_DEPTH_INDEX_CODE = '000300'

/** 一个宽基指数及其 ETF 篮子（冻结白名单：代码是唯一事实）。 */
export interface EtfRescueBasket {
  /** 六位指数代码（如 000300）。 */
  readonly indexCode: string
  /** 指数简称（诊断用，不参与计算）。 */
  readonly indexName: string
  /** 深度线图例名（EtfRescueHistory.depthLabel）。 */
  readonly depthLabel: string
  /** 指数行情市场前缀（腾讯 fqkline 的 sh/sz）。 */
  readonly exchange: 'sh' | 'sz'
  /** 该指数对应的宽基 ETF 代码篮子。 */
  readonly etfs: readonly string[]
}

/** 七个宽基指数篮子（冻结白名单）。 */
export const ETF_RESCUE_BASKETS: readonly EtfRescueBasket[] = [
  { indexCode: '000016', indexName: '上证50', depthLabel: '上证50ETF', exchange: 'sh', etfs: ['510050'] },
  { indexCode: '000300', indexName: '沪深300', depthLabel: '沪深300ETF', exchange: 'sh', etfs: ['510300', '510310', '510330', '159919'] },
  { indexCode: '000510', indexName: '中证A500', depthLabel: '中证A500ETF', exchange: 'sh', etfs: ['563360', '512050', '159338'] },
  { indexCode: '000905', indexName: '中证500', depthLabel: '中证500ETF', exchange: 'sh', etfs: ['510500', '159922'] },
  { indexCode: '000852', indexName: '中证1000', depthLabel: '中证1000ETF', exchange: 'sh', etfs: ['512100', '159845'] },
  { indexCode: '000688', indexName: '科创50', depthLabel: '科创50ETF', exchange: 'sh', etfs: ['588000', '588080'] },
  { indexCode: '399006', indexName: '创业板指', depthLabel: '创业板ETF', exchange: 'sz', etfs: ['159915'] },
]

/** 除沪深300 外的六个篮子（广度分子/分母的口径范围）。 */
export const ETF_RESCUE_OTHER_BASKETS: readonly EtfRescueBasket[] =
  ETF_RESCUE_BASKETS.filter((basket) => basket.indexCode !== ETF_RESCUE_DEPTH_INDEX_CODE)

/** 中证全指：覆盖沪深全市场，**没有跟踪它自己的宽基 ETF**（2026-11-22 实测两所名单里
 * 「全指」产品全是子指数），所以它的「篮子」是七个宽基篮子的并集——深度读作
 * 「国家队通过宽基 ETF 持有的规模 ÷ 全市场流通市值」。 */
export const ETF_RESCUE_ALL_SHARE_INDEX_CODE = '000985'

/** 中证全指篮子：只用于「该标的自己的深度」，**不进广度口径**（见 OTHER_BASKETS）。 */
export const ETF_RESCUE_ALL_SHARE_BASKET: EtfRescueBasket = {
  indexCode: ETF_RESCUE_ALL_SHARE_INDEX_CODE,
  indexName: '中证全指',
  depthLabel: '全市场宽基ETF',
  exchange: 'sh',
  // 并集去重：七个篮子没有任何重复代码，这里仍用 Set 表达「并集」这个语义。
  etfs: [...new Set(ETF_RESCUE_BASKETS.flatMap((basket) => basket.etfs))],
}

/**
 * 参与取数与 k 标定的全部指数（七个篮子 + 中证全指）。
 *
 * 与 ETF_RESCUE_BASKETS 分成两张表是有意的：广度口径冻结在「除沪深300 外的六个篮子」，
 * 中证全指覆盖全市场、把它算进广度分母会把同一批市值重复计一次。
 */
export const ETF_RESCUE_INDEX_BASKETS: readonly EtfRescueBasket[] = [
  ...ETF_RESCUE_BASKETS,
  ETF_RESCUE_ALL_SHARE_BASKET,
]

/** 白名单里的全部 ETF 代码（十五个，去重；中证全指篮子是并集，不引入新代码）。 */
export const ETF_RESCUE_BASKET_CODES: readonly string[] = [
  ...new Set(ETF_RESCUE_BASKETS.flatMap((basket) => basket.etfs)),
]

/** 篮子代码 → 是否属于冻结白名单（解析时只留白名单，缓存文件才不至于存全市场）。 */
export function isEtfRescueBasketCode(code: string): boolean {
  return ETF_RESCUE_BASKET_CODES.includes(code)
}

/** 指数代码 → 篮子（七个宽基 + 中证全指）；不在白名单返回 undefined。 */
export function findEtfRescueBasket(indexCode: string): EtfRescueBasket | undefined {
  return ETF_RESCUE_INDEX_BASKETS.find((basket) => basket.indexCode === indexCode)
}

/* ------------------------------------------------------------------ */
/* 符号解析                                                            */
/* ------------------------------------------------------------------ */

/** 规范化后的符号（市场规范形 = 代码 + 交易所后缀）。 */
export interface EtfRescueSymbol {
  readonly code: string
  readonly market: 'SH' | 'SZ'
  /** 市场规范形，如 000300.SH / 399006.SZ / 600519.SH。 */
  readonly canonical: string
}

/**
 * 抽出 6 位代码并判定交易所：接受 '000300.SH' / '000300' / 'SH000300' / 'sz399006'
 * 等形态。市场后缀/前缀优先，其次按白名单（白名单是唯一事实），最后按 A 股代码段
 * 兜底——600519 这类非宽基代码也要能规范化，才能作为「映射不到 → 空 points」的回执
 * symbol 返回。
 */
export function normalizeEtfRescueSymbol(symbol: string): EtfRescueSymbol | undefined {
  const clean = symbol.trim().toUpperCase()
  const codeMatch = /(\d{6})/.exec(clean)
  if (codeMatch === null) return undefined
  const code = codeMatch[1] as string

  const suffix = /\.(SH|SZ|SS)$/.exec(clean)
  const prefixed = /^(SH|SZ)\d{6}$/.test(clean)
  let market: 'SH' | 'SZ'
  if (suffix !== null) {
    market = suffix[1] === 'SZ' ? 'SZ' : 'SH'
  } else if (prefixed) {
    market = clean.startsWith('SZ') ? 'SZ' : 'SH'
  } else {
    const basket = findEtfRescueBasket(code)
    if (basket !== undefined) market = basket.exchange === 'sz' ? 'SZ' : 'SH'
    else if (code.startsWith('5') || code.startsWith('6') || code.startsWith('9')) market = 'SH'
    else market = 'SZ'
  }
  return { code, market, canonical: `${code}.${market}` }
}

/** getEtfRescue 的符号解析结果：symbol 恒为规范形（解析不出代码时原样大写返回）。 */
export interface EtfRescueResolution {
  readonly symbol: string
  readonly basket: EtfRescueBasket | undefined
}

/** 入参 → 规范形 symbol + 宽基篮子（不在白名单时 basket 为 undefined，不抛错）。 */
export function resolveEtfRescueTarget(symbol: string): EtfRescueResolution {
  const parsed = normalizeEtfRescueSymbol(symbol)
  if (parsed === undefined) return { symbol: symbol.trim().toUpperCase(), basket: undefined }
  return { symbol: parsed.canonical, basket: findEtfRescueBasket(parsed.code) }
}

/* ------------------------------------------------------------------ */
/* 日期与数值                                                          */
/* ------------------------------------------------------------------ */

/** 有限数（number 或非空数字串），其余（null/''/NaN/Infinity/布尔）返回 undefined。 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 'YYYY-MM-DD' → 当日 UTC 00:00 的 epoch ms（与日 K openTime 同口径）；非法返回 NaN。 */
export function tradingDateMs(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const ms = Date.UTC(year, month - 1, day)
  // Date.UTC 会把 2 月 30 日归一化成 3 月初：回读一次，只有真日期才认。
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : Number.NaN
}

/** 'YYYY-MM-DD' 是否合法日期。 */
export function isTradingDate(date: string): boolean {
  return !Number.isNaN(tradingDateMs(date))
}

/** 日期加减天数（只做 UTC 日历算术，不承担交易日判定）。 */
export function addDays(date: string, days: number): string {
  return new Date(tradingDateMs(date) + days * 86_400_000).toISOString().slice(0, 10)
}

/* ------------------------------------------------------------------ */
/* 上游响应解析                                                        */
/* ------------------------------------------------------------------ */

/** 上交所 ETF 份额行的最小面（只声明读到的字段）。 */
interface SseShareRow {
  readonly SEC_CODE?: unknown
  readonly TOT_VOL?: unknown
}

/**
 * 上交所 commonQuery 响应 → { ETF代码: 份额(份) }。
 *
 * TOT_VOL 单位是**万份**（实测 2024-02-05 返回 519 行），×10000 得份；
 * 只留白名单篮子代码（全市场一次取回，但缓存里只存要用的）。
 * 缺 TOT_VOL / 非数字 / 负值的行直接跳过——不补 0。
 */
export function parseSseEtfShares(payload: unknown): Record<string, number> {
  const result = (payload as { result?: unknown } | null | undefined)?.result
  if (!Array.isArray(result)) throw new Error('SSE ETF shares payload has no result[]')
  const shares: Record<string, number> = {}
  for (const raw of result) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as SseShareRow
    const code = typeof row.SEC_CODE === 'string' ? row.SEC_CODE.trim() : ''
    const volume = toFiniteNumber(row.TOT_VOL)
    if (!/^\d{6}$/.test(code) || !isEtfRescueBasketCode(code)) continue
    if (volume === undefined || volume <= 0) continue
    shares[code] = volume * 10_000
  }
  return shares
}

const XML_ENTITY: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

function decodeXmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITY[entity] ?? entity)
}

/** 单元格文本：先 inlineStr 的 <t>，再 <v>（数值格）。 */
function cellText(body: string): string | undefined {
  const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)
  if (inline !== null) return decodeXmlText(inline[1] as string)
  const value = /<v>([\s\S]*?)<\/v>/.exec(body)
  return value === null ? undefined : decodeXmlText(value[1] as string)
}

/**
 * 深交所 xlsx 的 sheet1.xml → { 交易日: { ETF代码: 份额(份) } }。
 *
 * 该 xlsx 的两个实测坑（2026-11-22 复核）：单元格是 **inlineStr**
 * （<c r="A2" t="inlineStr"><is><t>值</t></is></c>），没有 sharedStrings 可依赖；
 * 基金代码带尾随空格，必须 trim。列序：A=日期 / B=基金代码 / C=基金简称 /
 * D=基金规模(份)。表头行与非 6 位代码、缺规模的行走跳过路径。
 */
export function parseSzseSheetXml(xml: string): Record<string, Record<string, number>> {
  const byDate: Record<string, Record<string, number>> = {}
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  for (const rowMatch of xml.matchAll(rowPattern)) {
    const cells: Record<string, string> = {}
    const cellPattern = /<c\s+r="([A-Z]+)\d+"[^>]*>([\s\S]*?)<\/c>/g
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(cellPattern)) {
      const text = cellText(cellMatch[2] ?? '')
      if (text !== undefined) cells[cellMatch[1] as string] = text
    }
    const date = (cells.A ?? '').trim()
    if (!isTradingDate(date)) continue
    const code = (cells.B ?? '').trim()
    if (!/^\d{6}$/.test(code) || !isEtfRescueBasketCode(code)) continue
    const shares = toFiniteNumber(cells.D)
    if (shares === undefined || shares <= 0) continue
    const day = byDate[date] ?? {}
    day[code] = shares
    byDate[date] = day
  }
  return byDate
}

/** zip(xlsx) → sheet1.xml 文本；归档里没有该成员即抛（上游形态变了要响亮）。 */
export function readXlsxSheet(xlsx: Uint8Array): string {
  const files = unzipSync(xlsx)
  const key = Object.keys(files).find((name) => /(^|\/)worksheets\/sheet1\.xml$/.test(name))
  const sheet = key === undefined ? undefined : files[key]
  if (sheet === undefined) throw new Error('xlsx archive has no worksheets/sheet1.xml')
  return new TextDecoder().decode(sheet)
}

/** 深交所区间 xlsx → { 交易日: { ETF代码: 份额(份) } }。 */
export function parseSzseEtfShares(xlsx: Uint8Array): Record<string, Record<string, number>> {
  return parseSzseSheetXml(readXlsxSheet(xlsx))
}

/**
 * 基金历史净值响应 → { 交易日: 单位净值(元/份) }。
 *
 * Data 为 null/'' 是「区间内没有净值」（未成立/未披露），按空表返回；
 * LSJZList 存在但不是数组则是形态异常，抛错交给网络层映射。
 */
export function parseFundNavPayload(payload: unknown): Record<string, number> {
  const data = (payload as { Data?: unknown } | null | undefined)?.Data
  if (typeof data !== 'object' || data === null) return {}
  const list = (data as { LSJZList?: unknown }).LSJZList
  if (list === undefined || list === null) return {}
  if (!Array.isArray(list)) throw new Error('fund lsjz payload has non-array LSJZList')
  const navs: Record<string, number> = {}
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as { FSRQ?: unknown; DWJZ?: unknown }
    const date = typeof row.FSRQ === 'string' ? row.FSRQ.trim() : ''
    const nav = toFiniteNumber(row.DWJZ)
    if (!isTradingDate(date) || nav === undefined || nav <= 0) continue
    navs[date] = nav
  }
  return navs
}

/**
 * 腾讯 fqkline 响应 → { 交易日: 收盘 }。
 *
 * day[] 行序为 [日期, 开, 收, 高, 低, 量]，收盘在下标 2（不是 1）；qfq 复权口径下
 * 上游可能把数组放在 qfqday 键，但指数实测仍回 day，两处都认。
 */
export function parseTencentIndexCloses(payload: unknown, quoteKey: string): Record<string, number> {
  const data = (payload as { data?: unknown } | null | undefined)?.data
  if (typeof data !== 'object' || data === null) return {}
  const series = (data as Record<string, unknown>)[quoteKey]
  if (typeof series !== 'object' || series === null) return {}
  const rawDay = (series as { day?: unknown }).day
  const rawQfqDay = (series as { qfqday?: unknown }).qfqday
  const list = Array.isArray(rawDay) ? rawDay : Array.isArray(rawQfqDay) ? rawQfqDay : undefined
  if (list === undefined) return {}
  const closes: Record<string, number> = {}
  for (const raw of list) {
    if (!Array.isArray(raw)) continue
    const date = typeof raw[0] === 'string' ? raw[0].trim() : ''
    const close = toFiniteNumber(raw[2])
    if (!isTradingDate(date) || close === undefined || close <= 0) continue
    closes[date] = close
  }
  return closes
}

/** 指数流通市值标定读数：close 点位、floatMarketCap 元。 */
export interface IndexCalibrationReading {
  readonly close: number
  readonly floatMarketCap: number
  readonly source: 'push2-stock-get' | 'push2-ulist'
}

/**
 * 东财指数快照响应 → 标定读数（k = 流通市值 ÷ 点位）。
 *
 * 两种可用形态：
 *   - push2 stock/get：data.f43 = 点位×100、data.f117 = 流通市值(元)（契约主路径）；
 *   - push2 ulist.np/get：data.diff[0].f2 = 点位×100、data.diff[0].f21 = 流通市值(元)。
 * 两者是**同一个上游数量**：2026-11-22 实测 000300 的 f117 为 48236749043399.58，
 * 同时刻 ulist 的 f21 为 48236749043400（差为上游取整）；f2÷100 与腾讯当日收盘
 * 3954.570 同值。主路径不可用时按后一种形态读同一数量，缓存条目里以 source 留痕。
 */
export function parseIndexCalibration(payload: unknown): IndexCalibrationReading | undefined {
  const data = (payload as { data?: unknown } | null | undefined)?.data
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const f43 = toFiniteNumber(record.f43)
  const f117 = toFiniteNumber(record.f117)
  if (f43 !== undefined && f43 > 0 && f117 !== undefined && f117 > 0) {
    return { close: f43 / 100, floatMarketCap: f117, source: 'push2-stock-get' }
  }
  const diff = record.diff
  if (Array.isArray(diff) && diff.length > 0) {
    const row = diff[0]
    if (typeof row === 'object' && row !== null) {
      const f2 = toFiniteNumber((row as { f2?: unknown }).f2)
      const f21 = toFiniteNumber((row as { f21?: unknown }).f21)
      if (f2 !== undefined && f2 > 0 && f21 !== undefined && f21 > 0) {
        return { close: f2 / 100, floatMarketCap: f21, source: 'push2-ulist' }
      }
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* 规模 / 深度 / 广度                                                  */
/* ------------------------------------------------------------------ */

type NumberSeries = Readonly<Record<string, number>>
type SeriesByKey = Readonly<Record<string, NumberSeries>>

/** 单个 ETF 当日规模（元）= 份额(份) × 单位净值(元/份)；任一侧缺失返回 undefined。 */
export function etfScaleAt(
  code: string,
  date: string,
  sharesByCode: SeriesByKey,
  navByCode: SeriesByKey,
): number | undefined {
  const shares = sharesByCode[code]?.[date]
  const nav = navByCode[code]?.[date]
  if (shares === undefined || nav === undefined) return undefined
  if (!Number.isFinite(shares) || !Number.isFinite(nav) || shares <= 0 || nav <= 0) return undefined
  return shares * nav
}

/**
 * 一个篮子当日的规模合计（元）；一个可得的 ETF 都没有时返回 undefined
 * （空 ≠ 0：缺份额或缺净值的 ETF 不参与合计，绝不补 0）。
 */
export function basketScaleAt(
  basket: EtfRescueBasket,
  date: string,
  sharesByCode: SeriesByKey,
  navByCode: SeriesByKey,
): { readonly scale: number; readonly contributors: number } | undefined {
  let scale = 0
  let contributors = 0
  for (const code of basket.etfs) {
    const value = etfScaleAt(code, date, sharesByCode, navByCode)
    if (value === undefined) continue
    scale += value
    contributors += 1
  }
  return contributors === 0 ? undefined : { scale, contributors }
}

/** computeEtfRescuePoints 的输入（全部是已解析的日频表，键为 'YYYY-MM-DD'）。 */
export interface EtfRescueSeries {
  /** 目标宽基指数代码（决定深度篮子）。 */
  readonly targetIndexCode: string
  /** ETF代码 → 交易日 → 份额(份)。 */
  readonly sharesByCode: SeriesByKey
  /** ETF代码 → 交易日 → 单位净值(元/份)。 */
  readonly navByCode: SeriesByKey
  /** 指数代码 → 交易日 → 收盘点位。 */
  readonly closeByIndex: SeriesByKey
  /** 指数代码 → k（元/点）。 */
  readonly kByIndex: NumberSeries
  /** 回溯起点（缺省 ETF_RESCUE_START_DATE）。 */
  readonly startDate?: string
  /** 回溯终点（缺省不限）。 */
  readonly endDate?: string
}

/**
 * 三源（份额、净值、指数收盘）都齐备的交易日 → 升序去重的 EtfRescuePoint[]。
 *
 * 出点条件（冻结口径）：
 *   - 目标指数当日 close 与 k 可得，且目标篮子至少一只 ETF 的规模可得；
 *   - 广度分子/分母只取当日 close 与 k 都可得的「非300」指数：分母是它们的流通
 *     市值之和，分子是这些指数篮子的规模合计，至少一个篮子有规模才出点；
 *     000510 指数 2024-09-23 才发布，更早日期它没有 close，故整条不进合计
 *     （缺 = 未知，不是 0）；指数已发布但其 ETF 尚未上市时，该篮子规模贡献是
 *     真实的 0（渗透率确实为 0），分母照计。
 */
export function computeEtfRescuePoints(series: EtfRescueSeries): EtfRescuePoint[] {
  const startDate = series.startDate ?? ETF_RESCUE_START_DATE
  const target = findEtfRescueBasket(series.targetIndexCode)
  if (target === undefined) return []
  const targetCloses = series.closeByIndex[series.targetIndexCode] ?? {}
  const dates = Object.keys(targetCloses)
    .filter((date) => date >= startDate && (series.endDate === undefined || date <= series.endDate))
    .sort()

  const points: EtfRescuePoint[] = []
  for (const date of dates) {
    const targetClose = targetCloses[date]
    const targetK = series.kByIndex[series.targetIndexCode]
    if (targetClose === undefined || targetK === undefined) continue
    const targetMcap = targetK * targetClose
    const targetBasket = basketScaleAt(target, date, series.sharesByCode, series.navByCode)
    if (targetBasket === undefined || !(targetMcap > 0)) continue

    // 广度：分子与分母只取「当日 close 与 k 都可得」的指数——份额规模离开它自己的
    // 指数流通市值就没有可比的分母；指数没发布（000510 在 2024-09-23 之前）时它整条
    // 不进合计（空 ≠ 0），而不是拿它的 ETF 规模去配一个不存在的市值。
    let breadthScale = 0
    let breadthContributors = 0
    let breadthMcap = 0
    for (const other of ETF_RESCUE_OTHER_BASKETS) {
      const close = (series.closeByIndex[other.indexCode] ?? {})[date]
      const k = series.kByIndex[other.indexCode]
      if (close === undefined || k === undefined || !(k > 0) || !(close > 0)) continue
      breadthMcap += k * close
      const basket = basketScaleAt(other, date, series.sharesByCode, series.navByCode)
      if (basket === undefined) continue
      breadthScale += basket.scale
      breadthContributors += basket.contributors
    }
    if (breadthContributors === 0 || !(breadthMcap > 0) || !(breadthScale > 0)) continue

    const depthPct = (targetBasket.scale / targetMcap) * 100
    const breadthPct = (breadthScale / breadthMcap) * 100
    if (!Number.isFinite(depthPct) || !Number.isFinite(breadthPct)) continue
    if (depthPct <= 0 || breadthPct <= 0) continue
    points.push({ date: tradingDateMs(date), depthPct, breadthPct })
  }
  return points
}
