/**
 * hk_get_fundamentals 取数与解析层（WS4 港股财务与估值基本面数据面）。
 *
 * 直连腾讯港股公共行情端点（无 key，GBK 解码，符合铁律 #5）：
 *   - https://qt.gtimg.cn/q=r_hk00700
 *   - 解析总市值/流通市值、市盈率 TTM、动态市盈率、市净率 PB、股息率、换手率、振幅、52周区间等。
 *
 * @module @dshtrading/kit-hk/fundamentals
 */

import type { StockFundamentals } from '@dshtrading/api'

export interface HkFundamentalsOptions {
  symbol: string
  fetch?: typeof globalThis.fetch
}

export interface HkFundamentalsResult {
  data?: StockFundamentals
  amplitudePercent?: number
  turnoverValueHkd?: number
  nameEn?: string
  unavailable?: string[]
}

const TENCENT_HK_QUOTE_BASE = 'https://qt.gtimg.cn/q=r_hk'

/**
 * 东财公开端点统一取数（2026-09-02 审查整改）：最小 UA（不做浏览器伪装/伪造
 * Referer，docs/replication.md 数据源边界）+ 10s AbortSignal 超时（对齐
 * connector-tencent 模式，防爬取端点挂起拖死桥请求）。
 */
const UPSTREAM_TIMEOUT_MS = 10_000

async function fetchJsonUpstream<T>(url: string, fetchImpl: typeof globalThis.fetch): Promise<T | undefined> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!res.ok) return undefined
  return await res.json() as T
}

/** 规范化港股代码：接受 00700 / 700 / 00700.HK / 700.hk，输出 5 位补零代码与规范符号 00700.HK。 */
export function normalizeHkSymbol(input: string): { code5: string; canonical: string } {
  const raw = input.trim().toLowerCase().replace(/\.hk$/, '')
  if (!/^\d{1,5}$/.test(raw)) {
    throw new Error(`hk_get_fundamentals: invalid HK stock symbol ${JSON.stringify(input)} — expected e.g. 00700, 700, 00700.HK`)
  }
  const code5 = raw.padStart(5, '0')
  return {
    code5,
    canonical: `${code5}.HK`,
  }
}

function num(val: string | undefined): number | undefined {
  if (val === undefined || val === '') return undefined
  const n = Number(val)
  return Number.isFinite(n) ? n : undefined
}

export async function fetchHkFundamentals(options: HkFundamentalsOptions): Promise<HkFundamentalsResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const { code5, canonical } = normalizeHkSymbol(options.symbol)
  const unavailable: string[] = []

  try {
    const url = `${TENCENT_HK_QUOTE_BASE}${code5}`
    const res = await fetchImpl(url)
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const buf = await res.arrayBuffer()
    const text = new TextDecoder('gbk').decode(buf)
    const match = /="([^"]+)"/.exec(text)
    if (!match || !match[1]) {
      throw new Error(`no quote data returned for r_hk${code5}`)
    }
    const fields = match[1].split('~')
    if (fields.length < 45) {
      throw new Error(`incomplete quote data received for r_hk${code5} (fields: ${fields.length})`)
    }

    const name = fields[1]
    const price = num(fields[3])
    const turnoverValueHkd = num(fields[37])
    const peDynamic = num(fields[39])
    const amplitudePercent = num(fields[43])
    const totalMarketCapYi = num(fields[44]) // 亿港元
    const floatMarketCapYi = num(fields[45]) // 亿港元
    const nameEn = fields[46]
    const dividendYield = num(fields[47]) // 已经为百分比数值，如 1.17 表示 1.17%
    const fiftyTwoWeekHigh = num(fields[48])
    const fiftyTwoWeekLow = num(fields[49])
    const peTtm = num(fields[57]) ?? peDynamic
    const pb = num(fields[58])
    const turnoverRate = num(fields[59])

    const data: StockFundamentals = {
      symbol: canonical,
      name,
      marketCap: totalMarketCapYi ? totalMarketCapYi * 100_000_000 : undefined,
      floatMarketCap: floatMarketCapYi ? floatMarketCapYi * 100_000_000 : undefined,
      peTtm,
      peDynamic,
      pb,
      dividendYield: dividendYield ? dividendYield / 100 : undefined,
      turnoverRate,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      timestamp: Date.now(),
    }

    return {
      data,
      amplitudePercent,
      turnoverValueHkd,
      nameEn,
      unavailable,
    }
  } catch (err) {
    unavailable.push(`tencent-hk-quote: ${err instanceof Error ? err.message : String(err)}`)
    return { unavailable }
  }
}

/** 格式化港股财报日期为期别标签（YYYY/Q1, YYYY/H1, YYYY/Q3, YYYY/FY）。 */
export function formatHkReportPeriod(dateStr: string): string {
  if (!dateStr) return ''
  const m = /(\d{4})[-/](\d{2})[-/](\d{2})/.exec(dateStr)
  if (!m) return dateStr.slice(0, 7)
  const [, y, mo] = m
  if (mo === '03' || mo === '3') return `${y}/Q1`
  if (mo === '06' || mo === '6') return `${y}/H1`
  if (mo === '09' || mo === '9') return `${y}/Q3`
  if (mo === '12') return `${y}/FY`
  return `${y}/${mo}`
}

/** 从东财/公开端点动态拉取港股多期财务指标。 */
export async function fetchHkFinancialMatrix(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dshtrading/api').FinancialReportMatrix | undefined> {
  try {
    const { code5 } = normalizeHkSymbol(symbol)
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL&filter=(SECUCODE%3D%22${code5}.HK%22)&pageNumber=1&pageSize=8&sortTypes=-1&sortColumns=REPORT_DATE`
    const json = await fetchJsonUpstream<{ result?: { data?: Array<Record<string, unknown>> } }>(url, fetchImpl)
    if (json === undefined) return undefined
    const rawRows = json.result?.data
    if (!Array.isArray(rawRows) || rawRows.length === 0) return undefined

    const list = [...rawRows].reverse()
    const periods = list.map(r => formatHkReportPeriod(String(r.REPORT_DATE ?? '')))
    const latestPeriod = periods[periods.length - 1] ?? ''
    const latestReportTitle = latestPeriod ? `${latestPeriod.replace('/', '财年')} 财报` : undefined

    const makeRow = (
      id: string,
      name: string,
      valKey: string,
      yoyKey?: string,
      unit?: string,
    ): import('@dshtrading/api').FinancialIndicatorRow => {
      const values: Record<string, import('@dshtrading/api').FinancialCell> = {}
      list.forEach((r, idx) => {
        const p = periods[idx]!
        const rawVal = r[valKey]
        const val = typeof rawVal === 'number' && Number.isFinite(rawVal) ? rawVal : undefined
        let changePercent: number | undefined
        if (yoyKey && typeof r[yoyKey] === 'number') {
          changePercent = r[yoyKey] as number
        }
        values[p] = { value: val, changePercent }
      })
      return { id, name, unit, values }
    }

    const groups: import('@dshtrading/api').FinancialReportGroup[] = [
      {
        id: 'per_share',
        title: '每股指标',
        rows: [
          makeRow('bps', '每股净资产', 'BPS', 'BPS_YOY', 'HKD'),
          makeRow('basic_eps', '基本每股收益', 'BASIC_EPS', 'BASIC_EPS_YOY', 'HKD'),
          makeRow('dividend_ps', '每股股息', 'DPS', undefined, 'HKD'),
        ],
      },
      {
        id: 'profitability',
        title: '盈利能力',
        rows: [
          makeRow('gross_margin', '销售毛利率', 'GROSS_PROFIT_RATIO', undefined, '%'),
          makeRow('net_margin', '销售净利率', 'NET_PROFIT_RATIO', undefined, '%'),
          makeRow('roe', '净资产收益率 (ROE)', 'ROE', undefined, '%'),
          makeRow('roa', '总资产收益率 (ROA)', 'ROA', undefined, '%'),
        ],
      },
      {
        id: 'growth',
        title: '收益与成长',
        rows: [
          makeRow('revenue', '营业总收入', 'TOTAL_OPERATE_INCOME', 'TOTAL_OPERATE_INCOME_YOY', 'HKD'),
          makeRow('net_profit', '股东应占溢利/净利润', 'PARENT_NETPROFIT', 'PARENT_NETPROFIT_YOY', 'HKD'),
        ],
      },
    ]

    return {
      currency: 'HKD',
      latestReportTitle,
      periods,
      groups,
    }
  } catch {
    return undefined
  }
}

/** 获取完整港股基本面数据包。 */
export async function fetchHkFundamentalsPackage(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dshtrading/api').FundamentalsPackage> {
  const { canonical } = normalizeHkSymbol(symbol)
  const [quoteRes, matrix] = await Promise.all([
    fetchHkFundamentals({ symbol, fetch: fetchImpl }),
    fetchHkFinancialMatrix(symbol, fetchImpl),
  ])

  const stock = quoteRes.data ? {
    ...quoteRes.data,
    amplitudePercent: quoteRes.amplitudePercent,
  } : undefined

  return {
    market: 'hk',
    symbol: canonical,
    stock,
    matrix,
    profile: stock ? {
      symbol: canonical,
      name: stock.name ?? quoteRes.nameEn,
      description: `${stock.name ?? canonical}（港股上市公司），包含港股每股指标、盈利能力与历史多期财报。`,
    } : undefined,
  }
}

export function renderHkFundamentals(result: HkFundamentalsResult, requestedSymbol: string): string {
  const { data, amplitudePercent, turnoverValueHkd, nameEn, unavailable = [] } = result
  if (!data) {
    return `hk_get_fundamentals ${requestedSymbol}: no fundamental data available.${unavailable.length > 0 ? ` (errors: ${unavailable.join('; ')})` : ''}`
  }

  const lines: string[] = [
    `hk_get_fundamentals ${data.symbol}${data.name ? ` (${data.name})` : ''}${nameEn ? ` [${nameEn}]` : ''}:`,
  ]

  if (data.marketCap !== undefined) {
    const yi = (data.marketCap / 100_000_000).toFixed(2)
    lines.push(`- 总市值: ${yi} 亿港元 (HKD)`)
  }
  if (data.floatMarketCap !== undefined) {
    const yi = (data.floatMarketCap / 100_000_000).toFixed(2)
    lines.push(`- 流通市值: ${yi} 亿港元 (HKD)`)
  }
  if (data.peTtm !== undefined) {
    lines.push(`- 滚动市盈率 (PE TTM): ${data.peTtm.toFixed(2)}`)
  }
  if (data.peDynamic !== undefined) {
    lines.push(`- 动态市盈率: ${data.peDynamic.toFixed(2)}`)
  }
  if (data.pb !== undefined) {
    lines.push(`- 市净率 (PB): ${data.pb.toFixed(2)}`)
  }
  if (data.dividendYield !== undefined) {
    const pct = (data.dividendYield * 100).toFixed(2)
    lines.push(`- 股息率 (Dividend Yield): ${pct}%`)
  }
  if (data.turnoverRate !== undefined) {
    lines.push(`- 换手率: ${data.turnoverRate.toFixed(2)}%`)
  }
  if (amplitudePercent !== undefined) {
    lines.push(`- 振幅: ${amplitudePercent.toFixed(2)}%`)
  }
  if (turnoverValueHkd !== undefined) {
    const yi = (turnoverValueHkd / 100_000_000).toFixed(2)
    lines.push(`- 今日成交额: ${yi} 亿港元`)
  }
  if (data.fiftyTwoWeekLow !== undefined && data.fiftyTwoWeekHigh !== undefined) {
    lines.push(`- 52 周最高/最低: HK$${data.fiftyTwoWeekLow.toFixed(3)} ~ HK$${data.fiftyTwoWeekHigh.toFixed(3)}`)
  }

  if (unavailable.length > 0) {
    lines.push(`  (errors: ${unavailable.join('; ')})`)
  }

  return lines.join('\n')
}
