/**
 * cn_get_fundamentals 取数与解析层（WS4 A 股财务与估值基本面数据面）。
 *
 * 直连腾讯公共行情端点（无 key，GBK 解码，符合铁律 #5）：
 *   - https://qt.gtimg.cn/q=sh600519 / sz000001
 *   - 解析市值、流通市值、动态市盈率、市盈率 TTM、市净率 PB、换手率、振幅、涨跌停价、52周区间。
 *
 * @module @dsh-trading/kit-cn/fundamentals
 */

import type { StockFundamentals } from '@dsh-trading/api'

export interface CnFundamentalsOptions {
  symbol: string
  fetch?: typeof globalThis.fetch
}

export interface CnFundamentalsResult {
  data?: StockFundamentals
  amplitudePercent?: number
  limitUpPrice?: number
  limitDownPrice?: number
  peStatic?: number
  unavailable?: string[]
}

const TENCENT_QUOTE_BASE = 'https://qt.gtimg.cn/q='

/** 规范化 A 股符号并返回腾讯 wire 前缀小写形态（如 sh600519, sz000001）与规范符号（如 600519.SH）。 */
export function normalizeCnSymbol(input: string): { wire: string; canonical: string } {
  const raw = input.trim().toLowerCase()
  const m = /^(?:(sh|sz)(\d{6})|(\d{6})(?:\.(sh|sz))?)$/.exec(raw)
  if (!m) {
    throw new Error(`cn_get_fundamentals: invalid A-share symbol ${JSON.stringify(input)} — expected e.g. 600519, 600519.SH, sh600519`)
  }
  let prefix = m[1] ?? m[4]
  const code = m[2] ?? m[3]
  if (!prefix) {
    prefix = code.startsWith('6') || code.startsWith('9') || code.startsWith('688') ? 'sh' : 'sz'
  }
  return {
    wire: `${prefix}${code}`,
    canonical: `${code}.${prefix.toUpperCase()}`,
  }
}

function num(val: string | undefined): number | undefined {
  if (val === undefined || val === '') return undefined
  const n = Number(val)
  return Number.isFinite(n) ? n : undefined
}

export async function fetchCnFundamentals(options: CnFundamentalsOptions): Promise<CnFundamentalsResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const { wire, canonical } = normalizeCnSymbol(options.symbol)
  const unavailable: string[] = []

  try {
    const url = `${TENCENT_QUOTE_BASE}${wire}`
    const res = await fetchImpl(url)
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const buf = await res.arrayBuffer()
    const text = new TextDecoder('gbk').decode(buf)
    const match = /="([^"]+)"/.exec(text)
    if (!match || !match[1]) {
      throw new Error(`no quote data returned for ${wire}`)
    }
    const fields = match[1].split('~')
    if (fields.length < 45) {
      throw new Error(`incomplete quote data received for ${wire} (fields: ${fields.length})`)
    }

    const name = fields[1]
    const price = num(fields[3])
    const turnoverRate = num(fields[38])
    const peDynamic = num(fields[39])
    const amplitudePercent = num(fields[43])
    const floatMarketCapYi = num(fields[44]) // 亿元
    const totalMarketCapYi = num(fields[45]) // 亿元
    const pb = num(fields[46])
    const limitUpPrice = num(fields[47])
    const limitDownPrice = num(fields[48])
    const peStatic = num(fields[52])
    const peTtm = num(fields[53]) ?? peDynamic
    // 52 周高低在 f67/f68（2026-09-02 实测 sh600519，88 字段，
    // spikes/impl-cn-hk/r4-fundamentals/；旧值 68/69 比真实行多算一个空位）。
    const fiftyTwoWeekHigh = num(fields[67])
    const fiftyTwoWeekLow = num(fields[68])

    const data: StockFundamentals = {
      symbol: canonical,
      name,
      marketCap: totalMarketCapYi ? totalMarketCapYi * 100_000_000 : undefined,
      floatMarketCap: floatMarketCapYi ? floatMarketCapYi * 100_000_000 : undefined,
      peTtm,
      peDynamic,
      pb,
      turnoverRate,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      timestamp: Date.now(),
    }

    return {
      data,
      amplitudePercent,
      limitUpPrice,
      limitDownPrice,
      peStatic,
      unavailable,
    }
  } catch (err) {
    unavailable.push(`tencent-quote: ${err instanceof Error ? err.message : String(err)}`)
    return { unavailable }
  }
}

/** 格式化东财/腾讯日期为期别标签（YYYY/Q1, YYYY/H1, YYYY/Q3, YYYY/FY）。 */
export function formatReportPeriod(dateStr: string): string {
  if (!dateStr) return ''
  const m = /(\d{4})[-/](\d{2})[-/](\d{2})/.exec(dateStr)
  if (!m) return dateStr.slice(0, 7)
  const [, y, mo] = m
  if (mo === '03' || mo === '3') return `${y}/Q1`
  if (mo === '06' || mo === '6') return `${y}/H1`
  if (mo === '09' || mo === '9') return `${y}/Q3`
  if (mo === '12' || mo === '12') return `${y}/FY`
  return `${y}/${mo}`
}

export interface EastmoneyReportRow {
  REPORT_DATE?: string
  EPSJB?: number
  EPSXS?: number
  BPS?: number
  ROEJQ?: number
  ZZCJLL?: number
  XSMLL?: number
  XSJLL?: number
  TOTALOPERATEREVE?: number
  PARENTNETPROFIT?: number
  KCFJCXSYJLR?: number
  MGJYXJJE?: number
  ZCFZL?: number
  EPSJBTZ?: number
  BPSTZ?: number
  XSMLL_TB?: number
  TOTALOPERATEREVETZ?: number
  PARENTNETPROFITTZ?: number
  KCFJCXSYJLRTZ?: number
  ROEJQTZ?: number
  ZCFZLTZ?: number
  MGJYXJJETZ?: number
  SECURITY_NAME_ABBR?: string
}

/** 从东方财富 F10 动态拉取近 8 期真实财务报表矩阵（主：ZYZBAjaxNew，备：数据中心）。 */
export async function fetchCnFinancialMatrix(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').FinancialReportMatrix | undefined> {
  try {
    const { canonical, wire } = normalizeCnSymbol(symbol)
    const code = canonical.split('.')[0]!
    const prefix = wire.slice(0, 2).toUpperCase() // 'SZ' | 'SH'
    const fullCode = `${prefix}${code}`

    let rawRows: EastmoneyReportRow[] = []

    // 1. 优先请求东方财富 PC_HSF10 核心财务指标
    try {
      const f10Url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${fullCode}`
      const res = await fetchImpl(f10Url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
          Referer: 'https://emweb.securities.eastmoney.com/',
        },
      })
      if (res.ok) {
        const json = await res.json() as { data?: EastmoneyReportRow[] }
        if (Array.isArray(json.data) && json.data.length > 0) {
          rawRows = json.data.slice(0, 8)
        }
      }
    } catch {
      /* fallback to datacenter */
    }

    // 2. 备用：东方财富数据中心
    if (rawRows.length === 0) {
      try {
        const dcUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=(SECURITY_CODE%3D%22${code}%22)&pageNumber=1&pageSize=8&sortTypes=-1&sortColumns=REPORTDATE`
        const res = await fetchImpl(dcUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
            Referer: 'https://emweb.securities.eastmoney.com/',
          },
        })
        if (res.ok) {
          const json = await res.json() as { result?: { data?: EastmoneyReportRow[] } }
          if (Array.isArray(json.result?.data) && json.result.data.length > 0) {
            rawRows = json.result.data
          }
        }
      } catch {
        /* fallback */
      }
    }

    if (rawRows.length === 0) return undefined

    // 由旧到新排列（左旧右新）
    const list = [...rawRows].reverse()
    const periods = list.map(r => formatReportPeriod(r.REPORT_DATE ?? ''))
    const latestPeriod = periods[periods.length - 1] ?? ''
    const latestReportTitle = latestPeriod ? `${latestPeriod.replace('/', '财年')} 财报` : undefined

    const makeRow = (
      id: string,
      name: string,
      valKey: keyof EastmoneyReportRow,
      yoyKey?: keyof EastmoneyReportRow,
      unit?: string,
      isRatio = false,
    ): import('@dsh-trading/api').FinancialIndicatorRow => {
      const values: Record<string, import('@dsh-trading/api').FinancialCell> = {}
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

    const groups: import('@dsh-trading/api').FinancialReportGroup[] = [
      {
        id: 'per_share',
        title: '每股指标',
        rows: [
          makeRow('bps', '每股净资产', 'BPS', 'BPSTZ', '元'),
          makeRow('basic_eps', '基本每股收益', 'EPSJB', 'EPSJBTZ', '元'),
          makeRow('diluted_eps', '稀释每股收益', 'EPSXS', undefined, '元'),
          makeRow('operating_cash_flow_ps', '每股经营现金净流量', 'MGJYXJJE', 'MGJYXJJETZ', '元'),
        ],
      },
      {
        id: 'profitability',
        title: '盈利能力',
        rows: [
          makeRow('gross_margin', '销售毛利率', 'XSMLL', 'XSMLL_TB', '%', true),
          makeRow('net_margin', '销售净利率', 'XSJLL', undefined, '%', true),
          makeRow('roe', '净资产收益率 (ROE)', 'ROEJQ', 'ROEJQTZ', '%', true),
          makeRow('roa', '总资产收益率 (ROA)', 'ZZCJLL', undefined, '%', true),
        ],
      },
      {
        id: 'growth',
        title: '收益与成长',
        rows: [
          makeRow('revenue', '营业总收入', 'TOTALOPERATEREVE', 'TOTALOPERATEREVETZ', '元'),
          makeRow('net_profit', '归母净利润', 'PARENTNETPROFIT', 'PARENTNETPROFITTZ', '元'),
          makeRow('deduct_net_profit', '扣非净利润', 'KCFJCXSYJLR', 'KCFJCXSYJLRTZ', '元'),
        ],
      },
      {
        id: 'cash_debt',
        title: '现金流与偿债',
        rows: [
          makeRow('debt_to_asset_ratio', '资产负债率', 'ZCFZL', 'ZCFZLTZ', '%', true),
        ],
      },
    ]

    return {
      currency: 'CNY',
      latestReportTitle,
      periods,
      groups,
    }
  } catch {
    return undefined
  }
}

/** 从东方财富动态抓取公司详细概况与高管信息。 */
export async function fetchCnCompanyProfile(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').CompanyProfile | undefined> {
  try {
    const { canonical, wire } = normalizeCnSymbol(symbol)
    const code = canonical.split('.')[0]!
    const prefix = wire.slice(0, 2).toUpperCase()
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${prefix}${code}`
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Referer: 'https://emweb.securities.eastmoney.com/',
      },
    })
    if (!res.ok) return undefined
    const json = await res.json() as { jbzl?: Record<string, string> }
    const jb = json.jbzl
    if (!jb) return undefined

    const executives: Array<{ name: string; title: string }> = []
    if (jb.dsz) executives.push({ name: jb.dsz, title: '董事长' })
    if (jb.zjl && jb.zjl !== jb.dsz) executives.push({ name: jb.zjl, title: '总经理' })
    if (jb.dm) executives.push({ name: jb.dm, title: '董事会秘书' })
    if (jb.frdb && jb.frdb !== jb.dsz && jb.frdb !== jb.zjl) executives.push({ name: jb.frdb, title: '法定代表人' })

    return {
      symbol: canonical,
      name: jb.agjc || jb.gsmc,
      fullName: jb.gsmc,
      nameEn: jb.ywmc,
      industry: jb.sszjhhy || jb.sshy,
      sector: jb.sshy,
      chairman: jb.dsz,
      generalManager: jb.zjl,
      legalRepresentative: jb.frdb,
      boardSecretary: jb.dm,
      registeredCapital: jb.zczb,
      address: jb.bgdz || jb.zcdz,
      businessScope: jb.jyfw,
      employeeCount: jb.gyrs ? `${Number(jb.gyrs).toLocaleString()} 人` : undefined,
      description: jb.gsjj?.trim(),
      website: jb.gswz ? (jb.gswz.startsWith('http') ? jb.gswz : `https://${jb.gswz}`) : undefined,
      executives,
    }
  } catch {
    return undefined
  }
}

/** 从机构研报与公开数据中聚合机构盈利预测。 */
export async function fetchCnForecast(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').ForecastSummary | undefined> {
  try {
    const { canonical } = normalizeCnSymbol(symbol)
    const code = canonical.split('.')[0]!
    const url = `https://reportapi.eastmoney.com/report/list?industryCode=*&pageSize=10&industry=*&rating=&ratingChange=&beginTime=&endTime=&pageNo=1&fields=&qType=0&orgCode=&code=${code}`
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Referer: 'https://data.eastmoney.com/',
      },
    })
    if (!res.ok) return undefined
    const json = await res.json() as { data?: Array<Record<string, unknown>> }
    const list = json.data
    if (!Array.isArray(list) || list.length === 0) return undefined

    const epsThisYear: number[] = []
    const epsNextYear: number[] = []
    const epsNextTwoYear: number[] = []
    let buyCount = 0
    let holdCount = 0
    let sellCount = 0

    const currentYear = new Date().getFullYear()

    for (const item of list) {
      const thisEps = Number(item.predictThisYearEps)
      if (Number.isFinite(thisEps) && thisEps > 0) epsThisYear.push(thisEps)

      const nextEps = Number(item.predictNextYearEps)
      if (Number.isFinite(nextEps) && nextEps > 0) epsNextYear.push(nextEps)

      const nextTwoEps = Number(item.predictNextTwoYearEps)
      if (Number.isFinite(nextTwoEps) && nextTwoEps > 0) epsNextTwoYear.push(nextTwoEps)

      const rating = String(item.emRatingName || item.rating || '')
      if (rating.includes('买入') || rating.includes('增持') || rating.includes('强烈推荐')) {
        buyCount++
      } else if (rating.includes('中性') || rating.includes('持有')) {
        holdCount++
      } else if (rating.includes('减持') || rating.includes('卖出')) {
        sellCount++
      } else {
        buyCount++
      }
    }

    const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined)
    const avgThis = avg(epsThisYear)
    const avgNext = avg(epsNextYear)
    const avgNextTwo = avg(epsNextTwoYear)

    const items: Array<{ year: string; eps: number; revenue: number; netProfit: number; orgCount?: number }> = []
    if (avgThis !== undefined) {
      items.push({
        year: `${currentYear}E`,
        eps: Number(avgThis.toFixed(2)),
        revenue: 0,
        netProfit: 0,
        orgCount: epsThisYear.length,
      })
    }
    if (avgNext !== undefined) {
      items.push({
        year: `${currentYear + 1}E`,
        eps: Number(avgNext.toFixed(2)),
        revenue: 0,
        netProfit: 0,
        orgCount: epsNextYear.length,
      })
    }
    if (avgNextTwo !== undefined) {
      items.push({
        year: `${currentYear + 2}E`,
        eps: Number(avgNextTwo.toFixed(2)),
        revenue: 0,
        netProfit: 0,
        orgCount: epsNextTwoYear.length,
      })
    }

    return {
      epsCurrentYear: avgThis,
      epsNextYear: avgNext,
      buyRatingCount: buyCount,
      holdRatingCount: holdCount,
      sellRatingCount: sellCount,
      totalOrgs: list.length,
      items: items.length > 0 ? items : undefined,
    }
  } catch {
    return undefined
  }
}

/** 从东方财富动态抓取机构研究报告精选。 */
export async function fetchCnReports(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').ResearchReportItem[]> {
  try {
    const { canonical } = normalizeCnSymbol(symbol)
    const code = canonical.split('.')[0]!
    const url = `https://reportapi.eastmoney.com/report/list?industryCode=*&pageSize=10&industry=*&rating=&ratingChange=&beginTime=&endTime=&pageNo=1&fields=&qType=0&orgCode=&code=${code}`
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Referer: 'https://data.eastmoney.com/',
      },
    })
    if (!res.ok) return []
    const json = await res.json() as { data?: Array<Record<string, unknown>> }
    const rawList = json.data
    if (!Array.isArray(rawList)) return []

    return rawList.map((r, idx) => ({
      id: String(r.infoCode || `report_${idx}`),
      title: String(r.title || '个股研究报告'),
      orgName: String(r.orgSName || r.orgName || '机构研报'),
      author: Array.isArray(r.author) ? r.author.join(', ').replace(/^\d+\./, '') : String(r.researcher || r.author || ''),
      rating: String(r.emRatingName || r.rating || '买入'),
      publishDate: String(r.publishDate || '').slice(0, 10),
      summary: String(r.summary || r.coreView || `${r.orgSName || ''}发布《${r.title || ''}》，投资评级为【${r.emRatingName || '买入'}】。`),
      url: r.infoCode ? `https://data.eastmoney.com/report/zw_stock.jshtml?infocode=${r.infoCode}` : undefined,
    }))
  } catch {
    return []
  }
}

/** 从东方财富动态抓取主营构成。 */
export async function fetchCnMainOperations(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').MainOperationSegment[]> {
  try {
    const { canonical } = normalizeCnSymbol(symbol)
    const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FN_MAINOP&columns=ALL&filter=(SECUCODE%3D%22${canonical}%22)&pageNumber=1&pageSize=30&sortTypes=-1&sortColumns=REPORT_DATE`
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Referer: 'https://emweb.securities.eastmoney.com/',
      },
    })
    if (!res.ok) return []
    const json = await res.json() as { result?: { data?: Array<Record<string, unknown>> } }
    const rawList = json.result?.data
    if (!Array.isArray(rawList) || rawList.length === 0) return []

    const latestDate = rawList[0]?.REPORT_DATE
    const filtered = latestDate ? rawList.filter(r => r.REPORT_DATE === latestDate) : rawList.slice(0, 15)

    return filtered.map(r => {
      const typeCode = String(r.MAINOP_TYPE || '')
      const classification: 'product' | 'industry' | 'region' = typeCode === '1' ? 'industry' : typeCode === '3' ? 'region' : 'product'
      const rawRatio = Number(r.MBI_RATIO || 0)
      const ratio = rawRatio > 1 ? rawRatio : rawRatio * 100
      const rawMargin = Number(r.GROSS_RPOFIT_RATIO || 0)
      const grossMargin = rawMargin > 1 ? rawMargin : rawMargin * 100

      return {
        segmentName: String(r.ITEM_NAME || '主营业务'),
        classification,
        revenue: Number(r.MAIN_BUSINESS_INCOME || 0),
        revenueRatio: ratio,
        grossProfit: Number(r.MAIN_BUSINESS_RPOFIT || 0) || undefined,
        grossMargin: Number.isFinite(grossMargin) && grossMargin !== 0 ? grossMargin : undefined,
      }
    })
  } catch {
    return []
  }
}

/** 从东方财富动态抓取分红派息与拆股送转方案。 */
export async function fetchCnCorporateActions(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<{
  dividends: import('@dsh-trading/api').DividendItem[]
  splits: import('@dsh-trading/api').SplitItem[]
}> {
  try {
    const { canonical } = normalizeCnSymbol(symbol)
    const code = canonical.split('.')[0]!
    const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE%3D%22${code}%22)&pageNumber=1&pageSize=20&sortTypes=-1&sortColumns=REPORT_DATE`
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Referer: 'https://emweb.securities.eastmoney.com/',
      },
    })
    if (!res.ok) return { dividends: [], splits: [] }
    const json = await res.json() as { result?: { data?: Array<Record<string, unknown>> } }
    const rawList = json.result?.data
    if (!Array.isArray(rawList)) return { dividends: [], splits: [] }

    const dividends: import('@dsh-trading/api').DividendItem[] = []
    const splits: import('@dsh-trading/api').SplitItem[] = []

    for (const r of rawList) {
      const planYear = String(r.REPORT_DATE || r.PLAN_NOTICE_DATE || '').slice(0, 4)
      const planText = String(r.IMPL_PLAN_PROFILE || '分配方案')
      const cash = Number(r.PRETAX_BONUS_RMB || 0)
      const bonusRatio = Number(r.BONUS_RATIO || 0)
      const itRatio = Number(r.IT_RATIO || 0)

      if (cash > 0 || planText.includes('派')) {
        dividends.push({
          planYear,
          dividendPlan: planText,
          cashDividend: cash > 0 ? cash : undefined,
          exDividendDate: r.EX_DIVIDEND_DATE ? String(r.EX_DIVIDEND_DATE).slice(0, 10) : undefined,
          dividendDate: r.EQUITY_RECORD_DATE ? String(r.EQUITY_RECORD_DATE).slice(0, 10) : undefined,
          recordDate: r.NOTICE_DATE ? String(r.NOTICE_DATE).slice(0, 10) : undefined,
          dividendYield: typeof r.DIVIDENT_RATIO === 'number' ? r.DIVIDENT_RATIO : undefined,
        })
      }

      if (bonusRatio > 0 || itRatio > 0 || planText.includes('送') || planText.includes('转')) {
        splits.push({
          date: String(r.EX_DIVIDEND_DATE || r.NOTICE_DATE || r.REPORT_DATE || '').slice(0, 10),
          ratio: planText,
          description: `实施方案: 每10股送${bonusRatio}股, 转增${itRatio}股 (实施进度: ${r.ASSIGN_PROGRESS || '实施完成'})`,
        })
      }
    }

    return { dividends, splits }
  } catch {
    return { dividends: [], splits: [] }
  }
}

/** 从东方财富动态抓取经营效率指标。 */
export async function fetchCnEfficiency(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').OperatingEfficiency | undefined> {
  try {
    const { canonical } = normalizeCnSymbol(symbol)
    const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECUCODE%3D%22${canonical}%22)&pageNumber=1&pageSize=5&sortTypes=-1&sortColumns=REPORT_DATE`
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Referer: 'https://emweb.securities.eastmoney.com/',
      },
    })
    if (!res.ok) return undefined
    const json = await res.json() as { result?: { data?: Array<Record<string, unknown>> } }
    const d = json.result?.data?.[0]
    if (!d) return undefined

    return {
      inventoryTurnoverDays: typeof d.CHZZTS === 'number' ? d.CHZZTS : undefined,
      accountsReceivableTurnoverDays: typeof d.YSZKZZTS === 'number' ? d.YSZKZZTS : undefined,
      operatingCycleDays: typeof d.OPERATE_CYCLE === 'number' ? d.OPERATE_CYCLE : undefined,
      totalAssetTurnover: typeof d.TOAZZL === 'number' ? d.TOAZZL : undefined,
      grossProfitMargin: typeof d.XSMLL === 'number' ? d.XSMLL : undefined,
      netProfitMargin: typeof d.XSJLL === 'number' ? d.XSJLL : undefined,
      currentRatio: typeof d.LD === 'number' ? d.LD : undefined,
      quickRatio: typeof d.SD === 'number' ? d.SD : undefined,
      roe: typeof d.ROEJQ === 'number' ? d.ROEJQ : undefined,
    }
  } catch {
    return undefined
  }
}

/** 从东方财富动态抓取十大流通股东、机构持股与股东变动。 */
export async function fetchCnShareholdersData(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<{
  shareholders: import('@dsh-trading/api').ShareholderItem[]
  institutionalHoldings: import('@dsh-trading/api').InstitutionalHoldingItem[]
  insiderTrades: import('@dsh-trading/api').InsiderTradeItem[]
}> {
  try {
    const { canonical } = normalizeCnSymbol(symbol)
    const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_EH_FREEHOLDERS&columns=ALL&filter=(SECUCODE%3D%22${canonical}%22)&pageNumber=1&pageSize=10&sortTypes=-1&sortColumns=END_DATE`
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Referer: 'https://emweb.securities.eastmoney.com/',
      },
    })
    if (!res.ok) return { shareholders: [], institutionalHoldings: [], insiderTrades: [] }
    const json = await res.json() as { result?: { data?: Array<Record<string, unknown>> } }
    const rawList = json.result?.data
    if (!Array.isArray(rawList)) return { shareholders: [], institutionalHoldings: [], insiderTrades: [] }

    const shareholders: import('@dsh-trading/api').ShareholderItem[] = []
    const institutionalHoldings: import('@dsh-trading/api').InstitutionalHoldingItem[] = []
    const insiderTrades: import('@dsh-trading/api').InsiderTradeItem[] = []

    for (const r of rawList) {
      const name = String(r.HOLDER_NAME ?? '--')
      const shares = typeof r.HOLD_NUM === 'number' ? r.HOLD_NUM : undefined
      const ratio = typeof r.FREE_HOLDNUM_RATIO === 'number' ? r.FREE_HOLDNUM_RATIO : (typeof r.HOLD_RATIO === 'number' ? r.HOLD_RATIO : undefined)
      const change = r.HOLD_NUM_CHANGE !== undefined && r.HOLD_NUM_CHANGE !== null ? String(r.HOLD_NUM_CHANGE) : '不变'
      const orgType = String(r.HOLDER_TYPE || (r.IS_HOLDORG === '1' ? '机构投资者' : '一般股东'))
      const marketCap = typeof r.HOLDER_MARKET_CAP === 'number' ? r.HOLDER_MARKET_CAP : undefined

      shareholders.push({ name, shares, ratio, change })

      if (r.IS_HOLDORG === '1' || orgType.includes('公司') || orgType.includes('基金') || orgType.includes('香港') || orgType.includes('投资') || orgType.includes('保险')) {
        institutionalHoldings.push({
          orgName: name,
          orgType,
          holdingShares: shares ?? 0,
          holdingRatio: ratio ?? 0,
          marketCap,
          change,
        })
      }

      insiderTrades.push({
        holderName: name,
        changeType: change,
        changeShares: shares ?? 0,
        postHoldingRatio: ratio,
        date: r.UPDATE_DATE ? String(r.UPDATE_DATE).slice(0, 10) : undefined,
      })
    }

    return { shareholders, institutionalHoldings, insiderTrades }
  } catch {
    return { shareholders: [], institutionalHoldings: [], insiderTrades: [] }
  }
}

/** 从东方财富动态抓取股东户数与筹码集中度。 */
export async function fetchCnHoldersSummary(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').HolderNumSummary | undefined> {
  try {
    const { canonical } = normalizeCnSymbol(symbol)
    const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_EH_HOLDERNUM&columns=ALL&filter=(SECUCODE%3D%22${canonical}%22)&pageNumber=1&pageSize=5&sortTypes=-1&sortColumns=END_DATE`
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Referer: 'https://emweb.securities.eastmoney.com/',
      },
    })
    if (!res.ok) return undefined
    const json = await res.json() as { result?: { data?: Array<Record<string, unknown>> } }
    const first = json.result?.data?.[0]
    if (!first) return undefined

    return {
      totalHolders: Number(first.HOLDER_TOTAL_NUM) || undefined,
      totalHoldersChangeRatio: Number(first.TOTAL_NUM_RATIO) || undefined,
      avgFreeShares: Number(first.AVG_FREE_SHARES) || undefined,
      avgHoldAmount: Number(first.AVG_HOLD_AMT) || undefined,
      concentration: String(first.HOLD_FOCUS || '适中'),
      reportDate: String(first.END_DATE || '').slice(0, 10),
    }
  } catch {
    return undefined
  }
}

/** 兼容旧接口别名。 */
export async function fetchCnShareholders(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').ShareholderItem[]> {
  const res = await fetchCnShareholdersData(symbol, fetchImpl)
  return res.shareholders
}

/** 获取完整 A 股基本面数据包（估值 + 多期财务矩阵 + 深度简况 + 股东 + 预测 + 研报 + 经营 + 分红 + 送转）。 */
export async function fetchCnFundamentalsPackage(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').FundamentalsPackage> {
  const { canonical } = normalizeCnSymbol(symbol)
  const [quoteRes, matrix, profile, shData, forecast, reports, mainOperations, actions, holderSummary, efficiency] = await Promise.all([
    fetchCnFundamentals({ symbol, fetch: fetchImpl }),
    fetchCnFinancialMatrix(symbol, fetchImpl),
    fetchCnCompanyProfile(symbol, fetchImpl),
    fetchCnShareholdersData(symbol, fetchImpl),
    fetchCnForecast(symbol, fetchImpl),
    fetchCnReports(symbol, fetchImpl),
    fetchCnMainOperations(symbol, fetchImpl),
    fetchCnCorporateActions(symbol, fetchImpl),
    fetchCnHoldersSummary(symbol, fetchImpl),
    fetchCnEfficiency(symbol, fetchImpl),
  ])

  const stock = quoteRes.data ? {
    ...quoteRes.data,
    amplitudePercent: quoteRes.amplitudePercent,
    limitUpPrice: quoteRes.limitUpPrice,
    limitDownPrice: quoteRes.limitDownPrice,
    peStatic: quoteRes.peStatic,
  } : undefined

  return {
    market: 'cn',
    symbol: canonical,
    stock,
    matrix,
    profile: profile ?? (stock ? {
      symbol: canonical,
      name: stock.name,
      description: `${stock.name ?? canonical}（A股上市公司），包含每股指标、盈利能力、成长能力与现金流等多期财务指标。`,
    } : undefined),
    shareholders: shData.shareholders,
    institutionalHoldings: shData.institutionalHoldings,
    insiderTrades: shData.insiderTrades,
    forecast,
    reports,
    mainOperations,
    efficiency,
    holderSummary,
    dividends: actions.dividends,
    splits: actions.splits,
  }
}

export function renderCnFundamentals(result: CnFundamentalsResult, requestedSymbol: string): string {
  const { data, amplitudePercent, limitUpPrice, limitDownPrice, peStatic, unavailable = [] } = result
  if (!data) {
    return `cn_get_fundamentals ${requestedSymbol}: no fundamental data available.${unavailable.length > 0 ? ` (errors: ${unavailable.join('; ')})` : ''}`
  }

  const lines: string[] = [
    `cn_get_fundamentals ${data.symbol}${data.name ? ` (${data.name})` : ''}:`,
  ]

  if (data.marketCap !== undefined) {
    const yi = (data.marketCap / 100_000_000).toFixed(2)
    lines.push(`- 总市值: ${yi} 亿元 CNY`)
  }
  if (data.floatMarketCap !== undefined) {
    const yi = (data.floatMarketCap / 100_000_000).toFixed(2)
    lines.push(`- 流通市值: ${yi} 亿元 CNY`)
  }
  if (data.peTtm !== undefined) {
    lines.push(`- 滚动市盈率 (PE TTM): ${data.peTtm.toFixed(2)}`)
  }
  if (data.peDynamic !== undefined) {
    lines.push(`- 动态市盈率: ${data.peDynamic.toFixed(2)}`)
  }
  if (peStatic !== undefined) {
    lines.push(`- 静态市盈率: ${peStatic.toFixed(2)}`)
  }
  if (data.pb !== undefined) {
    lines.push(`- 市净率 (PB): ${data.pb.toFixed(2)}`)
  }
  if (data.turnoverRate !== undefined) {
    lines.push(`- 换手率: ${data.turnoverRate.toFixed(2)}%`)
  }
  if (amplitudePercent !== undefined) {
    lines.push(`- 振幅: ${amplitudePercent.toFixed(2)}%`)
  }
  if (limitUpPrice !== undefined && limitDownPrice !== undefined) {
    lines.push(`- 涨跌停区间: ¥${limitDownPrice.toFixed(2)} (跌停) ~ ¥${limitUpPrice.toFixed(2)} (涨停)`)
  }
  if (data.fiftyTwoWeekLow !== undefined && data.fiftyTwoWeekHigh !== undefined) {
    lines.push(`- 52 周最高/最低: ¥${data.fiftyTwoWeekLow.toFixed(2)} ~ ¥${data.fiftyTwoWeekHigh.toFixed(2)}`)
  }

  if (unavailable.length > 0) {
    lines.push(`  (errors: ${unavailable.join('; ')})`)
  }

  return lines.join('\n')
}
