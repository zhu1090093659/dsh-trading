/**
 * hk_get_fundamentals 取数与解析层（WS4 港股财务与估值基本面数据面）。
 *
 * 直连腾讯港股公共行情端点（无 key，GBK 解码，符合铁律 #5）：
 *   - https://qt.gtimg.cn/q=r_hk00700
 *   - 解析总市值/流通市值、市盈率 TTM、动态市盈率、市净率 PB、股息率、换手率、振幅、52周区间等。
 *
 * @module @dsh-trading/kit-hk/fundamentals
 */

import type { StockFundamentals } from '@dsh-trading/api'

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
