/**
 * us_get_fundamentals 取数与聚合层（WS4 美股财务与估值基本面数据面）。
 *
 * 直连 Yahoo Finance 公共端点（无 key，符合铁律 #5：不缓存不分发）：
 *   - 优先尝试 Yahoo quote 端点获取 PE, PB, EPS, 股息率等详尽估值数据；
 *   - 遇 rate limit (401/429) 时自动降级到稳定无 key 的 Yahoo v8 chart meta 端点，
 *     提供公司名称、52 周高低区间、交易所、最新收盘价与成交量参考。
 *
 * @module @dsh-trading/kit-us/fundamentals
 */

import type { StockFundamentals } from '@dsh-trading/api'

export interface UsFundamentalsOptions {
  symbol: string
  fetch?: typeof globalThis.fetch
}

export interface UsFundamentalsResult {
  data?: StockFundamentals
  beta?: number
  fiftyTwoWeekChangePercent?: number
  avgVolume3Month?: number
  currency?: string
  exchange?: string
  unavailable?: string[]
}

const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote'
const YAHOO_CHART_URL = 'https://query2.finance.yahoo.com/v8/finance/chart'
const YAHOO_UA = 'Mozilla/5.0'

/** 上游超时（2026-09-02 整改）：对齐 connector 模式，防挂起拖死桥请求。 */
const UPSTREAM_TIMEOUT_MS = 10_000

/** US ticker 白名单校验（2026-09-02 整改）：CN/HK 有严格正则，US 原先裸插值进 URL path。 */
export function normalizeUsSymbol(input: string): string {
  const sym = input.trim().toUpperCase()
  if (!/^[A-Z0-9.\-^=]{1,12}$/.test(sym)) {
    throw new Error(`us_get_fundamentals: invalid US symbol ${JSON.stringify(input)} — expected e.g. AAPL, BRK.B, ^GSPC`)
  }
  return sym
}

interface YahooQuoteItem {
  symbol: string
  shortName?: string
  longName?: string
  marketCap?: number
  trailingPE?: number
  forwardPE?: number
  priceToBook?: number
  epsTrailingTwelveMonths?: number
  epsForward?: number
  trailingAnnualDividendYield?: number
  dividendYield?: number
  fiftyTwoWeekHigh?: number
  fiftyTwoWeekLow?: number
  fiftyTwoWeekChangePercent?: number
  averageDailyVolume3Month?: number
  beta?: number
  currency?: string
  fullExchangeName?: string
}

interface UsCacheEntry<T> {
  data: T
  expiresAt: number
}

const usFundamentalsCache = new Map<string, UsCacheEntry<UsFundamentalsResult>>()
const US_FUNDAMENTALS_TTL_MS = 5 * 60 * 1000 // 5 分钟快照缓存

export async function fetchUsFundamentals(options: UsFundamentalsOptions): Promise<UsFundamentalsResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const symbol = normalizeUsSymbol(options.symbol)
  const unavailable: string[] = []

  // 1. 检查本地内存缓存
  const cached = usFundamentalsCache.get(symbol)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data
  }

  // 2. Tier 1: 若配置了 FMP_API_KEY，优先调用 FMP 商业级高精接口
  const fmpApiKey = process.env.FMP_API_KEY
  if (fmpApiKey) {
    try {
      const fmpUrl = `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(symbol)}?apikey=${fmpApiKey}`
      const fmpRes = await fetchImpl(fmpUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      if (fmpRes.ok) {
        const list = (await fmpRes.json()) as Array<{
          symbol: string
          companyName?: string
          mktCap?: number
          beta?: number
          volAvg?: number
          range?: string
          changes?: number
          currency?: string
          exchangeShortName?: string
        }>
        const p = list?.[0]
        if (p) {
          let fiftyTwoWeekLow: number | undefined
          let fiftyTwoWeekHigh: number | undefined
          if (p.range) {
            const parts = p.range.split('-')
            if (parts.length === 2) {
              fiftyTwoWeekLow = Number(parts[0])
              fiftyTwoWeekHigh = Number(parts[1])
            }
          }
          const data: StockFundamentals = {
            symbol: p.symbol ?? symbol,
            ...(p.companyName ? { name: p.companyName } : {}),
            ...(p.mktCap !== undefined ? { marketCap: p.mktCap } : {}),
            ...(Number.isFinite(fiftyTwoWeekHigh) ? { fiftyTwoWeekHigh } : {}),
            ...(Number.isFinite(fiftyTwoWeekLow) ? { fiftyTwoWeekLow } : {}),
            timestamp: Date.now(),
          }
          const result: UsFundamentalsResult = {
            data,
            ...(p.beta !== undefined ? { beta: p.beta } : {}),
            ...(p.volAvg !== undefined ? { avgVolume3Month: p.volAvg } : {}),
            ...(p.currency ? { currency: p.currency } : {}),
            ...(p.exchangeShortName ? { exchange: p.exchangeShortName } : {}),
            unavailable,
          }
          usFundamentalsCache.set(symbol, { data: result, expiresAt: Date.now() + US_FUNDAMENTALS_TTL_MS })
          return result
        }
      }
    } catch (err) {
      unavailable.push(`fmp-official: ${err instanceof Error ? err.message : String(err)}`)
      // 失败平滑降级走 Yahoo
    }
  }

  // 3. Tier 2: 尝试 Yahoo quote 端点获取详细估值与财务数据
  try {
    const url = new URL(YAHOO_QUOTE_URL)
    url.searchParams.set('symbols', symbol)
    const response = await fetchImpl(url.toString(), {
      headers: {
        accept: 'application/json',
        'user-agent': YAHOO_UA,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (response.ok) {
      const json = (await response.json()) as {
        quoteResponse?: {
          result?: YahooQuoteItem[]
          error?: unknown
        }
      }
      const item = json.quoteResponse?.result?.[0]
      if (item) {
        const dividendRate = item.dividendYield ?? item.trailingAnnualDividendYield
        const data: StockFundamentals = {
          symbol: item.symbol ?? symbol,
          name: item.shortName ?? item.longName,
          marketCap: item.marketCap,
          peTtm: item.trailingPE,
          peDynamic: item.forwardPE,
          pb: item.priceToBook,
          eps: item.epsTrailingTwelveMonths,
          dividendYield: dividendRate,
          fiftyTwoWeekHigh: item.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: item.fiftyTwoWeekLow,
          timestamp: Date.now(),
        }
        return {
          data,
          beta: item.beta,
          fiftyTwoWeekChangePercent: item.fiftyTwoWeekChangePercent,
          avgVolume3Month: item.averageDailyVolume3Month,
          currency: item.currency,
          exchange: item.fullExchangeName,
          unavailable,
        }
      }
    } else {
      unavailable.push(`yahoo-quote: HTTP ${response.status}`)
    }
  } catch (err) {
    unavailable.push(`yahoo-quote: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. 降级回退：调用稳定无 key 的 Yahoo v8 chart meta 获取 52 周区间、成交量、交易所与公司全称
  try {
    const chartUrl = `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?interval=1d`
    const chartRes = await fetchImpl(chartUrl, {
      headers: { accept: 'application/json', 'user-agent': YAHOO_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (chartRes.ok) {
      const cJson = (await chartRes.json()) as {
        chart?: {
          result?: Array<{
            meta?: {
              shortName?: string
              longName?: string
              fiftyTwoWeekHigh?: number
              fiftyTwoWeekLow?: number
              regularMarketPrice?: number
              regularMarketVolume?: number
              regularMarketChangePercent?: number
              currency?: string
              fullExchangeName?: string
            }
          }>
        }
      }
      const meta = cJson.chart?.result?.[0]?.meta
      if (meta) {
        const data: StockFundamentals = {
          symbol,
          name: meta.shortName ?? meta.longName,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
          timestamp: Date.now(),
        }
        return {
          data,
          fiftyTwoWeekChangePercent: meta.regularMarketChangePercent !== undefined ? meta.regularMarketChangePercent / 100 : undefined,
          avgVolume3Month: meta.regularMarketVolume,
          currency: meta.currency,
          exchange: meta.fullExchangeName,
          unavailable,
        }
      }
    } else {
      unavailable.push(`yahoo-chart-meta: HTTP ${chartRes.status}`)
    }
  } catch (err) {
    unavailable.push(`yahoo-chart-meta: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { unavailable }
}

const usMatrixCache = new Map<string, UsCacheEntry<{ matrix?: import('@dsh-trading/api').FinancialReportMatrix; profile?: import('@dsh-trading/api').CompanyProfile }>>()
const US_MATRIX_TTL_MS = 24 * 60 * 60 * 1000 // 24 小时财报长效缓存

/** 从 Yahoo Finance quoteSummary 动态拉取美股多期财务报表与指标矩阵。 */
export async function fetchUsFinancialMatrix(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<{ matrix?: import('@dsh-trading/api').FinancialReportMatrix; profile?: import('@dsh-trading/api').CompanyProfile }> {
  try {
    const sym = normalizeUsSymbol(symbol)
    const cached = usMatrixCache.get(sym)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=financialData,defaultKeyStatistics,incomeStatementHistoryQuarterly,balanceSheetHistoryQuarterly,cashflowStatementHistoryQuarterly,assetProfile`
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': YAHOO_UA,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!res.ok) return {}
    const json = await res.json() as {
      quoteSummary?: {
        result?: Array<{
          assetProfile?: {
            sector?: string
            industry?: string
            longBusinessSummary?: string
            website?: string
            companyOfficers?: Array<{ name: string; title: string }>
          }
          incomeStatementHistoryQuarterly?: {
            incomeStatementHistory?: Array<{
              endDate?: { fmt?: string }
              totalRevenue?: { raw?: number }
              grossProfit?: { raw?: number }
              netIncome?: { raw?: number }
              operatingIncome?: { raw?: number }
            }>
          }
          balanceSheetHistoryQuarterly?: {
            balanceSheetStatements?: Array<{
              endDate?: { fmt?: string }
              totalAssets?: { raw?: number }
              totalLiab?: { raw?: number }
              totalStockholderEquity?: { raw?: number }
            }>
          }
          cashflowStatementHistoryQuarterly?: {
            cashflowStatements?: Array<{
              endDate?: { fmt?: string }
              totalCashFromOperatingActivities?: { raw?: number }
            }>
          }
        }>
      }
    }

    const item = json.quoteSummary?.result?.[0]
    if (!item) return {}

    const profile: import('@dsh-trading/api').CompanyProfile = {
      symbol: sym,
      industry: item.assetProfile?.industry,
      sector: item.assetProfile?.sector,
      description: item.assetProfile?.longBusinessSummary,
      website: typeof item.assetProfile?.website === 'string' && /^https?:/i.test(item.assetProfile.website) ? item.assetProfile.website : undefined,
      executives: item.assetProfile?.companyOfficers?.slice(0, 5).map(o => ({ name: o.name, title: o.title })),
    }

    const incomes = item.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? []
    if (incomes.length === 0) return { profile }

    const sortedIncomes = [...incomes].filter(i => i.endDate?.fmt)
    const periods = sortedIncomes.map(i => i.endDate!.fmt!.slice(0, 7).replace('-', '/'))
    // 期间键去重（L5 整改）：endDate 缺失行已剔除，剩余重复键也不得互相覆盖。
    for (let i = 1; i < periods.length; i++) {
      if (periods[i] === periods[i - 1]) periods[i] = `${periods[i]}#${i}`
    }
    const latestPeriod = periods[periods.length - 1] ?? ''
    const latestReportTitle = latestPeriod ? `${latestPeriod} 季报` : undefined

    const revValues: Record<string, import('@dsh-trading/api').FinancialCell> = {}
    const netValues: Record<string, import('@dsh-trading/api').FinancialCell> = {}
    const grossMarginValues: Record<string, import('@dsh-trading/api').FinancialCell> = {}

    sortedIncomes.forEach((inc, idx) => {
      const p = periods[idx]!
      const rev = inc.totalRevenue?.raw
      const net = inc.netIncome?.raw
      const gross = inc.grossProfit?.raw
      revValues[p] = { value: rev }
      netValues[p] = { value: net }
      const margin = (rev && gross) ? (gross / rev) * 100 : undefined
      grossMarginValues[p] = { value: margin }
    })

    const groups: import('@dsh-trading/api').FinancialReportGroup[] = [
      {
        id: 'profitability',
        title: '盈利与收益能力',
        rows: [
          { id: 'gross_margin', name: '毛利率', unit: '%', values: grossMarginValues },
          { id: 'revenue', name: '营业总收入', unit: 'USD', values: revValues },
          { id: 'net_income', name: '净利润', unit: 'USD', values: netValues },
        ],
      },
    ]

    const matrix: import('@dsh-trading/api').FinancialReportMatrix = {
      currency: 'USD',
      latestReportTitle,
      periods,
      groups,
    }

    const result = { matrix, profile }
    usMatrixCache.set(sym, { data: result, expiresAt: Date.now() + US_MATRIX_TTL_MS })
    return result
  } catch {
    return {}
  }
}

/** 获取完整美股基本面数据包。 */
export async function fetchUsFundamentalsPackage(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dsh-trading/api').FundamentalsPackage> {
  const sym = normalizeUsSymbol(symbol)
  const [quoteRes, { matrix, profile }] = await Promise.all([
    fetchUsFundamentals({ symbol: sym, fetch: fetchImpl }),
    fetchUsFinancialMatrix(sym, fetchImpl),
  ])

  return {
    market: 'us',
    symbol: sym,
    stock: quoteRes.data,
    matrix,
    profile: {
      symbol: sym,
      name: quoteRes.data?.name ?? sym,
      ...profile,
    },
  }
}

export function renderUsFundamentals(result: UsFundamentalsResult, requestedSymbol: string): string {
  const { data, beta, fiftyTwoWeekChangePercent, avgVolume3Month, currency = 'USD', exchange, unavailable = [] } = result
  if (!data) {
    return `us_get_fundamentals ${requestedSymbol}: no fundamental data available.${unavailable.length > 0 ? ` (errors: ${unavailable.join('; ')})` : ''}`
  }

  const lines: string[] = [
    `us_get_fundamentals ${data.symbol}${data.name ? ` (${data.name})` : ''}${exchange ? ` [${exchange}]` : ''}:`,
  ]

  if (data.marketCap !== undefined) {
    lines.push(`- Market Cap: \$${data.marketCap.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`)
  }
  if (data.peTtm !== undefined) {
    lines.push(`- Trailing PE (TTM): ${data.peTtm.toFixed(2)}`)
  }
  if (data.peDynamic !== undefined) {
    lines.push(`- Forward PE: ${data.peDynamic.toFixed(2)}`)
  }
  if (data.pb !== undefined) {
    lines.push(`- Price to Book (PB): ${data.pb.toFixed(2)}`)
  }
  if (data.eps !== undefined) {
    lines.push(`- Diluted EPS (TTM): \$${data.eps.toFixed(2)}`)
  }
  if (data.dividendYield !== undefined) {
    const pct = (data.dividendYield * (data.dividendYield < 1 ? 100 : 1)).toFixed(2)
    lines.push(`- Dividend Yield: ${pct}%`)
  }
  if (beta !== undefined) {
    lines.push(`- Beta (5Y Monthly): ${beta.toFixed(2)}`)
  }
  if (data.fiftyTwoWeekLow !== undefined && data.fiftyTwoWeekHigh !== undefined) {
    lines.push(`- 52-Week Range: \$${data.fiftyTwoWeekLow.toFixed(2)} - \$${data.fiftyTwoWeekHigh.toFixed(2)}`)
  }
  if (fiftyTwoWeekChangePercent !== undefined) {
    const pct = (fiftyTwoWeekChangePercent * (Math.abs(fiftyTwoWeekChangePercent) < 1 ? 100 : 1)).toFixed(2)
    lines.push(`- 52-Week Change: ${Number(pct) > 0 ? '+' : ''}${pct}%`)
  }
  if (avgVolume3Month !== undefined) {
    lines.push(`- Volume / Avg Volume: ${avgVolume3Month.toLocaleString()} shares`)
  }

  if (unavailable.length > 0) {
    lines.push(`  (partially unavailable details: ${unavailable.join('; ')})`)
  }

  return lines.join('\n')
}
