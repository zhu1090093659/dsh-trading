/**
 * 「发给 Agent」消息文案（纯函数，vitest 直测）：
 * 把行情头的快照统计 + 当前 K 线读数 + 已开指标压成一段 agent 可直接
 * 读懂的上下文文本。截图是否附上只影响尾注（图是 model 侧视觉输入，
 * 文本始终自足）。
 */
import { fmtChange, fmtCompact, fmtPercent, fmtPrice } from './format.ts'
import type { Kline } from './types.ts'

export interface QuoteMessageInput {
  name?: string
  symbol: string
  marketLabel: string
  intervalLabel: string
  price?: number
  change?: number
  pct?: number
  prevClose?: number
  /** 十字线读数 K 线（未悬停 = 最新一根）。 */
  candle?: Kline
  indicatorTitles: readonly string[]
  withScreenshot: boolean
}

export function composeQuoteMessage(input: QuoteMessageInput): string {
  const title = [input.name ?? input.symbol, input.symbol, input.marketLabel, input.intervalLabel]
    .filter(part => part !== '')
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(' · ')
  const lines: string[] = [`看一下我正在看的行情：${title}`]
  if (input.price !== undefined) {
    const delta = input.change !== undefined
      ? `（${fmtChange(input.change)}${input.pct !== undefined ? ` / ${fmtPercent(input.pct)}` : ''}）`
      : ''
    const prev = input.prevClose !== undefined ? `，昨收 ${fmtPrice(input.prevClose)}` : ''
    lines.push(`现价 ${fmtPrice(input.price)}${delta}${prev}`)
  }
  if (input.candle !== undefined) {
    lines.push(
      `当根K线 开 ${fmtPrice(input.candle.open)} 高 ${fmtPrice(input.candle.high)} `
      + `低 ${fmtPrice(input.candle.low)} 收 ${fmtPrice(input.candle.close)} 量 ${fmtCompact(input.candle.volume)}`,
    )
  }
  if (input.indicatorTitles.length > 0) lines.push(`已开启指标：${input.indicatorTitles.join('、')}`)
  lines.push(input.withScreenshot ? '随消息附当前图表截图，请结合分析。' : '请结合当前行情继续分析。')
  return lines.join('\n')
}
