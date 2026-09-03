/**
 * 「发给 Agent」消息文案（纯函数，vitest 直测）：
 * 把行情头的快照统计 + 当前 K 线读数 + 已开指标压成一段 agent 可直接
 * 读懂的上下文文本。截图是否附上只影响尾注（图是 model 侧视觉输入，
 * 文本始终自足）。
  *
 * i18n-allow: 默认文案常量与 zh 词典同源（copy 面由词典注入，缺省仅向后兼容）。
 */
import { fmtChange, fmtCompact, fmtPercent, fmtPrice, type CompactLocale } from './format.ts'
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

/** composeQuoteMessage 的文案面（由 QuoteStage 用词典值注入，保持纯函数可测）。 */
export interface QuoteMessageCopy {
  /** 开场句（已含 {title} 槽）。 */
  opener: string
  /** 昨收后缀（含 {price} 槽；change 缺失时用）。 */
  prevClose: string
  /** 现价行前缀（后接价格 + 变化括注）。 */
  priceLine: string
  /** 当根 K 线行（各槽已按 en 语序排布，值由调用方填）。 */
  candleLine: string
  /** 已开指标前缀（{titles} 槽，分隔符由词典决定）。 */
  indicatorsLine: string
  listSeparator: string
  /** 涨跌括注包裹符（zh 全角（）/ en 半角 ()），评审 M3：标点随语言走。 */
  deltaWrap: [string, string]
  /** 昨收前连接符（zh 全角逗号 / en 半角逗号+空格）。 */
  prevSep: string
  /** 紧凑数值单位体系（亿/万 ↔ B/M/K），评审 M3：量槽不再硬编码 zh。 */
  volumeLocale: CompactLocale
  withScreenshotTail: string
  withoutScreenshotTail: string
}

export function composeQuoteMessage(input: QuoteMessageInput, copy?: QuoteMessageCopy): string {
  const c = copy ?? ZH_COPY
  const title = [input.name ?? input.symbol, input.symbol, input.marketLabel, input.intervalLabel]
    .filter(part => part !== '')
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(' · ')
  const lines: string[] = [c.opener.replace('{title}', title)]
  if (input.price !== undefined) {
    const delta = input.change !== undefined
      ? `${c.deltaWrap[0]}${fmtChange(input.change)}${input.pct !== undefined ? ` / ${fmtPercent(input.pct)}` : ''}${c.deltaWrap[1]}`
      : ''
    const prev = input.prevClose !== undefined ? `${c.prevSep}${c.prevClose.replace('{price}', fmtPrice(input.prevClose))}` : ''
    lines.push(`${c.priceLine} ${fmtPrice(input.price)}${delta}${prev}`)
  }
  if (input.candle !== undefined) {
    lines.push(
      c.candleLine
        .replace('{open}', fmtPrice(input.candle.open))
        .replace('{high}', fmtPrice(input.candle.high))
        .replace('{low}', fmtPrice(input.candle.low))
        .replace('{close}', fmtPrice(input.candle.close))
        .replace('{volume}', fmtCompact(input.candle.volume, c.volumeLocale)),
    )
  }
  if (input.indicatorTitles.length > 0) lines.push(`${c.indicatorsLine.replace('{titles}', input.indicatorTitles.join(c.listSeparator))}`)
  lines.push(input.withScreenshot ? c.withScreenshotTail : c.withoutScreenshotTail)
  return lines.join('\n')
}

/** 默认中文文案（向后兼容：不传 copy 时行为与历史版本一致）。 */
const ZH_COPY: QuoteMessageCopy = {
  opener: '看一下我正在看的行情：{title}',
  prevClose: '昨收 {price}',
  priceLine: '现价',
  candleLine: '当根K线 开 {open} 高 {high} 低 {low} 收 {close} 量 {volume}',
  indicatorsLine: '已开启指标：{titles}',
  listSeparator: '、',
  deltaWrap: ['（', '）'],
  prevSep: '，',
  volumeLocale: 'zh',
  withScreenshotTail: '随消息附当前图表截图，请结合分析。',
  withoutScreenshotTail: '请结合当前行情继续分析。',
}
