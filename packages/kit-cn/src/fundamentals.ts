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
