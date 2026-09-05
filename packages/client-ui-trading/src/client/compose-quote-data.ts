/**
 * 「发给 Agent」数据位置段组装（纯函数，vitest 直测）：
 * 在快照摘要（compose-quote.ts）之后追加「范围 + 取数位置 + 指标读数」——
 * 当前图表序列从多久到多久、共几根，Agent 用哪个工具、什么参数能取得
 * 同源数据；已开指标直接透出计算后的结果数值（与快照「当根K线」同根，
 * 即图表读数行口径）。
 *
 * owner 2026-09-05 裁决：K 线数据**不内联**——分析由 Agent 调工具取数后
 * 写代码完成；指标则**直接发结果**——只给参数让他复算属多此一举
 * （内联 CSV 方案同样已否决，见 Agent Note 2026-09-05）。
 *
 * i18n-allow: 默认文案常量与 zh 词典同源（copy 面由词典注入，缺省仅向后兼容）。
 */
import type { Kline } from './types.ts'

/** 一个指标实例的读数面（与图表 legend 同源：output key + 当根数值）。 */
export interface QuoteIndicatorReadout {
  title: string
  outputs: ReadonlyArray<{ key: string; value: number | undefined }>
}

export interface QuoteDataSectionInput {
  market: string
  symbol: string
  /** 周期 id（与 fetchKlines / <market>_get_klines 的 INTERVAL_VOCABULARY 同一口径，如 '1d'）。 */
  interval: string
  klines: ReadonlyArray<Kline>
  /** 已开指标的当根读数（warm-up 未就绪的分量由组装方跳过）。 */
  indicatorReadouts: ReadonlyArray<QuoteIndicatorReadout>
  /** K 线复取工具名（如 cn_get_klines——各市场连接器统一注册，同一路由数据源）。 */
  klinesTool: string
}

/** composeQuoteDataSection 的文案面（由 QuoteStage 用词典值注入，保持纯函数可测）。 */
export interface QuoteDataSectionCopy {
  header: string
  /** 范围行（{range} {count} {interval} {tz} 槽）。 */
  range: string
  /** 取数位置行（{tool} {symbol} {interval} {limit} 槽）。 */
  locate: string
  /** 指标读数行（{list} 槽；无有效读数时整行省略）。 */
  indicators: string
}

/** 日线粒度周期：范围只落日期；其余视为盘中周期（日期 + 时分）。 */
const DAY_LIKE_INTERVALS = new Set(['1d', '1w', '1M'])

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** openTime（毫秒）→ 本地时区时间戳（日线类只落日期）。 */
export function barTimeCell(openTime: number, intraday: boolean): string {
  const date = new Date(openTime)
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return intraday ? `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}` : day
}

/** 本地时区标签（UTC+8 / UTC-5.5 / UTC）。 */
export function timezoneLabel(): string {
  const minutes = -new Date().getTimezoneOffset()
  if (minutes === 0) return 'UTC'
  const hours = Math.abs(minutes) / 60
  return `UTC${minutes > 0 ? '+' : '-'}${Number.isInteger(hours) ? String(hours) : hours.toFixed(1)}`
}

function fill(template: string, slots: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (raw, key: string) => (key in slots ? String(slots[key]) : raw))
}

/**
 * 指标读数 → `标题 key=value, ...`（图表 legend 同款两位小数；warm-up
 * 分量跳过，整组无有效值时整组省略）。
 */
function formatReadout(readout: QuoteIndicatorReadout): string | undefined {
  const entries: string[] = []
  for (const output of readout.outputs) {
    if (output.value === undefined || !Number.isFinite(output.value)) continue
    entries.push(`${output.key}=${output.value.toFixed(2)}`)
  }
  return entries.length > 0 ? `${readout.title} ${entries.join(', ')}` : undefined
}

export function composeQuoteDataSection(input: QuoteDataSectionInput, copy: QuoteDataSectionCopy = ZH_COPY): string {
  const klines = input.klines
  if (klines.length === 0) return ''
  const intraday = !DAY_LIKE_INTERVALS.has(input.interval)
  const first = barTimeCell(klines[0]!.openTime, intraday)
  const last = barTimeCell(klines[klines.length - 1]!.openTime, intraday)

  const lines: string[] = [copy.header]
  lines.push(fill(copy.range, {
    range: `${first} ~ ${last}`,
    count: klines.length,
    interval: input.interval,
    tz: timezoneLabel(),
  }))
  lines.push(fill(copy.locate, {
    tool: input.klinesTool,
    symbol: input.symbol,
    interval: input.interval,
    limit: klines.length,
  }))
  const readouts = input.indicatorReadouts
    .map(formatReadout)
    .filter((entry): entry is string => entry !== undefined)
  if (readouts.length > 0) lines.push(fill(copy.indicators, { list: readouts.join('; ') }))
  return lines.join('\n')
}

/** 默认中文文案（与 zh 词典 compose.data.* 同源；不传 copy 时行为一致）。 */
const ZH_COPY: QuoteDataSectionCopy = {
  header: '【图表数据 · 范围与取数位置（与截图同一序列）】',
  range: '范围：{range} · 共{count}根 · interval={interval} · {tz}（最新一根为进行中的当根K线）',
  locate: '取数位置：Agent 可调用 {tool} 工具（symbol={symbol}，interval={interval}，limit={limit}）取得同源序列，再用工具与代码分析。',
  indicators: '已开指标读数（与上方当根K线同根）：{list}',
}
