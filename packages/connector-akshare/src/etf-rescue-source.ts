/**
 * @dshtrading/connector-akshare/etf-rescue-source
 * 「ETF 托底」网络面：五个上游端点的取数与重试/节流，不碰文件系统。
 *
 * 端点与实测坑（2026-11-22 现场复核，勿按记忆改参）：
 *   1) 上交所 ETF 份额：commonQuery.do 按 STAT_DATE 单日全市场一次取回
 *      （实测 2024-02-05 = 519 行；TOT_VOL 单位万份；非交易日回 result:[]）。
 *   2) 深交所 ETF 份额：ShowReport xlsx，区间单次 **≤6 个月**；实测跨度 5.7 个月
 *      时响应在 65536 行处截断（丢掉最早的日期），故调用方按 ≤3 个月切窗。
 *      SHOWTYPE 只认 xlsx（其它返回 500）。
 *   3) 基金单位净值：f10/lsjz。**pageSize 上限实测 20**（更大值只回 20 行，
 *      ≥300 直接回 Data:null / TotalCount:0），故按 TotalCount 翻页；startDate 过滤
 *      有效（510300 从 2023-01-01 起 TotalCount=942）。该端点缺 User-Agent 回 ErrCode -999。
 *   4) 指数收盘：腾讯 fqkline，param 支持 [起,止] 日期区间（增量取数用）与 ≤2000 根计数。
 *   5) 指数流通市值标定：push2 stock/get（f43 点位×100、f117 流通市值元）。
 *      该端点在本机持续传输层空回（2026-11-22 连续 10 次失败，与
 *      spikes/impl-eastmoney-quote-endpoint/ 的结论一致），故主路径失败后按
 *      ulist.np/get 的 f2/f21 读同一个数量（等价性证据见 parseIndexCalibration）。
 *
 * 错误词汇遵循本包既有约定：HTTP 非 2xx / 形态异常 = TRADING_UPSTREAM_ERROR，
 * 传输层失败 = TRADING_NETWORK；不静默补 0，也不把失败包装成空数据。
 */

import { TradingServiceError } from './rest.js'
import {
  findEtfRescueBasket,
  parseFundNavPayload,
  parseIndexCalibration,
  parseSseEtfShares,
  parseSzseEtfShares,
  parseTencentIndexCloses,
  readXlsxSheet,
  type IndexCalibrationReading,
} from './etf-rescue.js'

/** 基金净值端点要求非空 User-Agent（缺它回 ErrCode -999），用固定浏览器串保证跨环境一致。 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

const SSE_REFERER = 'https://www.sse.com.cn/'
const SZSE_REFERER = 'https://www.szse.cn/market/fund/volume/etf/index.html'
const FUND_REFERER = 'https://fundf10.eastmoney.com/'
const EASTMONEY_REFERER = 'https://quote.eastmoney.com/'

const SSE_SHARES_ENDPOINT = 'https://query.sse.com.cn/commonQuery.do'
const SZSE_SHARES_ENDPOINT = 'https://www.szse.cn/api/report/ShowReport'
const FUND_NAV_ENDPOINT = 'https://api.fund.eastmoney.com/f10/lsjz'
const TENCENT_KLINE_ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const EASTMONEY_STOCK_SNAPSHOT = 'https://push2.eastmoney.com/api/qt/stock/get'
const EASTMONEY_LIST_SNAPSHOT = 'https://push2.eastmoney.com/api/qt/ulist.np/get'

/** 基金净值单页行数（端点硬上限，实测 20）。 */
export const FUND_NAV_PAGE_SIZE = 20

/** 净值翻页的防御上限（20 行/页 × 300 页 = 6000 个交易日，够二十年）。 */
const FUND_NAV_MAX_PAGES = 300

/** 标定请求的最小间隔（冻结：逐只请求、间隔 ≥200ms）。 */
export const CALIBRATION_MIN_INTERVAL_MS = 200

/** 单次标定尝试的失败重试次数（冻结：失败重试一次）。 */
const CALIBRATION_ATTEMPTS = 2

/** 其它端点的尝试次数（一次正常请求 + 一次重试）。 */
const REQUEST_ATTEMPTS = 2

export interface EtfRescueSourceOptions {
  /** 注入 fetch（测试用；缺省全局 fetch）。 */
  readonly fetchImpl?: typeof fetch | undefined
  /** 普通请求超时（缺省 30s；深交所区间 xlsx 可能几 MB）。 */
  readonly timeoutMs?: number | undefined
  /** 标定请求之间的间隔（缺省 CALIBRATION_MIN_INTERVAL_MS；测试传 0 免等待）。 */
  readonly calibrationDelayMs?: number | undefined
  /** 注入等待函数（测试用；缺省 setTimeout）。 */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  /** 注入时钟（测试固定 calibratedAt；缺省 new Date()）。 */
  readonly now?: (() => Date) | undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * 「ETF 托底」上游取数客户端。
 *
 * 每个方法只做「发请求 → 解析」；重试与节流在这里收口，缓存与编排在 service 层。
 */
export class EtfRescueSource {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly calibrationDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => Date

  constructor(options: EtfRescueSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.calibrationDelayMs = options.calibrationDelayMs ?? CALIBRATION_MIN_INTERVAL_MS
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? (() => new Date())
  }

  private async request(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new TradingServiceError(
        'TRADING_NETWORK',
        'etf-rescue network error (' + url + '): ' + errorMessage(error),
        error,
      )
    }
    if (!response.ok) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        'etf-rescue HTTP ' + response.status + ' ' + response.statusText + ' (' + url + ')',
      )
    }
    return response
  }

  private async requestText(url: string, headers: Record<string, string>, timeoutMs = this.timeoutMs): Promise<string> {
    const response = await this.request(url, headers, timeoutMs)
    try {
      return await response.text()
    } catch (error) {
      throw new TradingServiceError('TRADING_NETWORK', 'etf-rescue read error (' + url + '): ' + errorMessage(error), error)
    }
  }

  private async requestJson(url: string, headers: Record<string, string>, timeoutMs = this.timeoutMs): Promise<unknown> {
    const text = await this.requestText(url, headers, timeoutMs)
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        'etf-rescue invalid JSON (' + url + '): ' + text.slice(0, 120),
        error,
      )
    }
  }

  private async requestBytes(url: string, headers: Record<string, string>, timeoutMs = this.timeoutMs): Promise<Uint8Array> {
    const response = await this.request(url, headers, timeoutMs)
    try {
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      throw new TradingServiceError('TRADING_NETWORK', 'etf-rescue read error (' + url + '): ' + errorMessage(error), error)
    }
  }

  /** 一次正常请求 + 一次重试（两次都失败时抛最后一次的可诊断错误）。 */
  private async withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
    let last: unknown
    for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
      try {
        return await run()
      } catch (error) {
        last = error
        if (attempt < REQUEST_ATTEMPTS) await this.sleep(400 * attempt)
      }
    }
    if (last instanceof TradingServiceError) throw last
    throw new TradingServiceError(
      'TRADING_UPSTREAM_ERROR',
      'etf-rescue ' + label + ' failed: ' + errorMessage(last),
      last,
    )
  }

  /** 上交所某交易日全市场 ETF 份额 → { 代码: 份 }（只留白名单篮子代码）。 */
  async fetchSseShares(date: string): Promise<Record<string, number>> {
    const url =
      SSE_SHARES_ENDPOINT +
      '?isPagination=true&pageHelp.pageSize=10000&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1' +
      '&sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L&STAT_DATE=' + date
    return this.withRetry('sse shares ' + date, async () => {
      const payload = await this.requestJson(url, { Referer: SSE_REFERER, Accept: 'application/json' })
      try {
        return parseSseEtfShares(payload)
      } catch (error) {
        throw new TradingServiceError(
          'TRADING_UPSTREAM_ERROR',
          'etf-rescue sse shares ' + date + ': ' + errorMessage(error),
          error,
        )
      }
    })
  }

  /** 深交所区间 ETF 份额 → { 交易日: { 代码: 份 } }（区间必须 ≤3 个月，见文件头）。 */
  async fetchSzseShares(startDate: string, endDate: string): Promise<Record<string, Record<string, number>>> {
    const random = Math.random().toFixed(6)
    const url =
      SZSE_SHARES_ENDPOINT +
      '?SHOWTYPE=xlsx&CATALOGID=scsj_fund_jjgm&TABKEY=tab1&txtStart=' + startDate +
      '&txtEnd=' + endDate + '&jjlb=ETF&random=' + random
    return this.withRetry('szse shares ' + startDate + '..' + endDate, async () => {
      const bytes = await this.requestBytes(
        url,
        { Referer: SZSE_REFERER, 'User-Agent': BROWSER_USER_AGENT },
        120_000,
      )
      let parsed: Record<string, Record<string, number>>
      try {
        parsed = parseSzseEtfShares(bytes)
      } catch (error) {
        throw new TradingServiceError(
          'TRADING_UPSTREAM_ERROR',
          'etf-rescue szse shares ' + startDate + '..' + endDate + ': ' + errorMessage(error),
          error,
        )
      }
      if (Object.keys(parsed).length === 0) {
        // 区间超限时深交所回一个只有 XML 声明、没有表头的 xlsx（实测 >6 个月）：
        // 这不是「区间内没有交易日」，而是上游拒绝了本次查询，必须响亮。
        let header = ''
        try {
          header = readXlsxSheet(bytes)
        } catch {
          header = ''
        }
        if (!header.includes('日期')) {
          throw new TradingServiceError(
            'TRADING_UPSTREAM_ERROR',
            'etf-rescue szse shares ' + startDate + '..' + endDate + ': 上游返回空表（区间可能超过 6 个月）',
          )
        }
      }
      return parsed
    })
  }

  /**
   * 基金单位净值 → { 交易日: 净值 }。
   *
   * pageSize 实测上限 20：按 TotalCount 翻页直到不足一页。startDate 给回溯起点，
   * 冷启动也不会把二十年历史全拉下来。
   */
  async fetchFundNav(code: string, startDate: string): Promise<Record<string, number>> {
    return this.withRetry('fund nav ' + code, async () => {
      const navs: Record<string, number> = {}
      for (let page = 1; page <= FUND_NAV_MAX_PAGES; page += 1) {
        const url =
          FUND_NAV_ENDPOINT +
          '?fundCode=' + code +
          '&pageIndex=' + page +
          '&pageSize=' + FUND_NAV_PAGE_SIZE +
          '&startDate=' + startDate + '&endDate='
        const payload = await this.requestJson(url, { Referer: FUND_REFERER, 'User-Agent': BROWSER_USER_AGENT })
        const errCode = (payload as { ErrCode?: unknown } | null | undefined)?.ErrCode
        if (typeof errCode === 'number' && errCode !== 0) {
          throw new TradingServiceError(
            'TRADING_UPSTREAM_ERROR',
            'etf-rescue fund lsjz ErrCode ' + errCode + ' for ' + code,
          )
        }
        let pageNavs: Record<string, number>
        try {
          pageNavs = parseFundNavPayload(payload)
        } catch (error) {
          throw new TradingServiceError(
            'TRADING_UPSTREAM_ERROR',
            'etf-rescue fund nav ' + code + ': ' + errorMessage(error),
            error,
          )
        }
        const rows = Object.keys(pageNavs).length
        Object.assign(navs, pageNavs)
        const total = (payload as { TotalCount?: unknown } | null | undefined)?.TotalCount
        const totalCount = typeof total === 'number' && Number.isFinite(total) ? total : 0
        if (rows < FUND_NAV_PAGE_SIZE || page * FUND_NAV_PAGE_SIZE >= totalCount) break
      }
      return navs
    })
  }

  /** 指数日线收盘 → { 交易日: 收盘 }（腾讯，param 支持日期区间）。 */
  async fetchIndexCloses(indexCode: string, startDate: string, endDate: string): Promise<Record<string, number>> {
    const basket = findEtfRescueBasket(indexCode)
    const exchange = basket?.exchange ?? (indexCode.startsWith('399') ? 'sz' : 'sh')
    const quoteKey = exchange + indexCode
    const spanMs = Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')
    const spanDays = Math.max(1, Math.round(spanMs / 86_400_000))
    // 计数上限：实测 1500 可回、3200 报 param error；按区间自然日 ×2 + 余量，封顶 2000。
    const count = Math.min(2000, Math.max(120, spanDays * 2 + 40))
    const url =
      TENCENT_KLINE_ENDPOINT + '?param=' + quoteKey + ',day,' + startDate + ',' + endDate + ',' + count + ',qfq'
    return this.withRetry('index closes ' + indexCode, async () => {
      const payload = await this.requestJson(url, { Referer: 'https://gu.qq.com/' }, 20_000)
      const msg = (payload as { msg?: unknown } | null | undefined)?.msg
      if (typeof msg === 'string' && msg.trim() !== '') {
        throw new TradingServiceError(
          'TRADING_UPSTREAM_ERROR',
          'etf-rescue tencent kline ' + indexCode + ': ' + msg,
        )
      }
      return parseTencentIndexCloses(payload, quoteKey)
    })
  }

  /** 单次标定尝试（含一次重试）；任何失败都返回 undefined，由调用方决定沿用旧 k。 */
  private async attemptCalibration(url: string): Promise<IndexCalibrationReading | undefined> {
    for (let attempt = 1; attempt <= CALIBRATION_ATTEMPTS; attempt += 1) {
      try {
        const payload = await this.requestJson(
          url,
          { Referer: EASTMONEY_REFERER, 'User-Agent': BROWSER_USER_AGENT },
          15_000,
        )
        const reading = parseIndexCalibration(payload)
        if (reading !== undefined) return reading
      } catch {
        // 标定是尽力而为：失败沿用上次 k（缓存里也没有时才向上抛），不在这里放大。
      }
      if (attempt < CALIBRATION_ATTEMPTS) await this.sleep(this.calibrationDelayMs)
    }
    return undefined
  }

  /**
   * 标定一个指数的流通市值系数 k（元/点）。
   *
   * 主路径按契约打 push2 stock/get 的 f117 ÷ f43；主路径持续空回时按 ulist.np/get 的
   * f21 ÷ (f2/100) 读同一个数量（等价性证据见 parseIndexCalibration 注释）。
   * 每次请求之间至少间隔 calibrationDelayMs（缺省 200ms），逐只串行。
   */
  async calibrateIndex(indexCode: string): Promise<(IndexCalibrationReading & { readonly k: number }) | undefined> {
    const secid = (indexCode.startsWith('399') ? 0 : 1) + '.' + indexCode
    const primaryUrl = EASTMONEY_STOCK_SNAPSHOT + '?secid=' + secid + '&fields=f43,f58,f117'
    const primary = await this.attemptCalibration(primaryUrl)
    await this.sleep(this.calibrationDelayMs)
    if (primary !== undefined) return { ...primary, k: primary.floatMarketCap / primary.close }

    const fallbackUrl = EASTMONEY_LIST_SNAPSHOT + '?secids=' + secid + '&fields=f2,f12,f14,f21'
    const fallback = await this.attemptCalibration(fallbackUrl)
    await this.sleep(this.calibrationDelayMs)
    if (fallback !== undefined) return { ...fallback, k: fallback.floatMarketCap / fallback.close }
    return undefined
  }

  /** 当前时刻（标定条目的 calibratedAt 用）。 */
  nowIso(): string {
    return this.now().toISOString()
  }
}
