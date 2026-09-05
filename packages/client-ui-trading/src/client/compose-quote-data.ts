/**
 * 「发给 Agent」数据段组装（纯函数，vitest 直测）：
 * 在快照摘要（compose-quote.ts）之后追加「K 线全序列 + 已开指标逐柱数值」
 * 的机器可读数据块——截图只是视觉输入，文本数据自足；同时给出数据位置
 * （market/symbol/interval + 复取工具），Agent 可直接用内联数据分析，也可
 * 按同参数复核或取更长历史（各市场连接器统一注册 <market>_get_klines，
 * kit/部分连接器另注册 <market>_get_indicators 指标复算）。
 *
 * i18n-allow: 默认文案常量与 zh 词典同源（copy 面由词典注入，缺省仅向后兼容）。
 */
import type { Kline } from './types.ts'

/** 指标组的最小结构面（与 QuoteStage indicatorGroups 结构兼容，渲染字段不感知）。 */
export interface QuoteDataIndicatorGroup {
  id: string
  title: string
  outputs: ReadonlyArray<{ key: string; values: ReadonlyArray<number | undefined> }>
}

export interface QuoteDataSectionInput {
  market: string
  symbol: string
  /** 周期 id（与 fetchKlines / <market>_get_klines 的 INTERVAL_VOCABULARY 同一口径，如 '1d'）。 */
  interval: string
  klines: ReadonlyArray<Kline>
  indicatorGroups: ReadonlyArray<QuoteDataIndicatorGroup>
  /** K 线复取工具名（如 cn_get_klines）。 */
  klinesTool: string
  /** 指标复算工具名（如 cn_get_indicators）；缺席时省略该行。 */
  indicatorsTool?: string
  /** 内联行数上限（保留最近 N 根；缺省 300——composer 草稿体积与 token 成本护栏）。 */
  maxRows?: number
}

/** composeQuoteDataSection 的文案面（由 QuoteStage 用词典值注入，保持纯函数可测）。 */
export interface QuoteDataSectionCopy {
  header: string
  /** 数据位置行（{market} {symbol} {interval} {count} {range} {tz} 槽）。 */
  locator: string
  /** 复取指引行（{tool} {symbol} {interval} {limit} 槽）。 */
  refetch: string
  /** 指标复算行（{tool} 槽）。 */
  indicators: string
  /** 截断说明（{inlined} {count} 槽）。 */
  truncated: string
  /** 全量说明（{count} 槽）。 */
  full: string
  /** 语义注记行（time 口径 / warm-up 空值）。 */
  note: string
}

const DEFAULT_MAX_ROWS = 300
/** 日线粒度周期：time 列只落日期；其余视为盘中周期（日期 + 时分）。 */
const DAY_LIKE_INTERVALS = new Set(['1d', '1w', '1M'])

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** openTime（毫秒）→ 本地时区时间单元格（日线类只落日期）。 */
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

function num(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? String(value) : ''
}

function fill(template: string, slots: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (raw, key: string) => (key in slots ? String(slots[key]) : raw))
}

/** 展平指标列；output key 跨组撞名时以「指标名.key」消歧。 */
function indicatorColumns(
  groups: ReadonlyArray<QuoteDataIndicatorGroup>,
): Array<{ header: string; values: ReadonlyArray<number | undefined> }> {
  const flat = groups.flatMap(group => group.outputs.map(output => ({ group, output })))
  const counts = new Map<string, number>()
  for (const entry of flat) counts.set(entry.output.key, (counts.get(entry.output.key) ?? 0) + 1)
  return flat.map(entry => ({
    header: (counts.get(entry.output.key) ?? 0) > 1 ? `${entry.group.title}.${entry.output.key}` : entry.output.key,
    values: entry.output.values,
  }))
}

export function composeQuoteDataSection(input: QuoteDataSectionInput, copy: QuoteDataSectionCopy = ZH_COPY): string {
  const klines = input.klines
  if (klines.length === 0) return ''
  const intraday = !DAY_LIKE_INTERVALS.has(input.interval)
  const columns = indicatorColumns(input.indicatorGroups)
  const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS
  const rows = maxRows > 0 && klines.length > maxRows ? klines.slice(klines.length - maxRows) : klines
  const truncated = rows.length < klines.length
  const first = barTimeCell(klines[0]!.openTime, false)
  const last = barTimeCell(klines[klines.length - 1]!.openTime, false)
  const offset = klines.length - rows.length

  const lines: string[] = [copy.header]
  lines.push(fill(copy.locator, {
    market: input.market,
    symbol: input.symbol,
    interval: input.interval,
    count: klines.length,
    range: `${first} ~ ${last}`,
    tz: timezoneLabel(),
  }))
  lines.push(fill(copy.refetch, {
    tool: input.klinesTool,
    symbol: input.symbol,
    interval: input.interval,
    limit: klines.length,
  }))
  if (input.indicatorsTool !== undefined) lines.push(fill(copy.indicators, { tool: input.indicatorsTool }))
  lines.push(fill(truncated ? copy.truncated : copy.full, { inlined: rows.length, count: klines.length }))
  lines.push(copy.note)
  lines.push('')
  lines.push('```csv')
  lines.push(['time', 'open', 'high', 'low', 'close', 'volume', ...columns.map(column => column.header)].join(','))
  for (let row = 0; row < rows.length; row++) {
    const kline = rows[row]!
    const index = offset + row
    const cells = [
      barTimeCell(kline.openTime, intraday),
      num(kline.open),
      num(kline.high),
      num(kline.low),
      num(kline.close),
      num(kline.volume),
    ]
    for (const column of columns) cells.push(num(column.values[index]))
    lines.push(cells.join(','))
  }
  lines.push('```')
  return lines.join('\n')
}

/** 默认中文文案（与 zh 词典 compose.data.* 同源；不传 copy 时行为一致）。 */
const ZH_COPY: QuoteDataSectionCopy = {
  header: '【图表数据 · 与截图同一序列，可直接用于分析】',
  locator: '数据位置：market={market} · symbol={symbol} · interval={interval} · 共{count}根 · {range} · {tz}',
  refetch: '复核或取更长历史：Agent 可调用 {tool} 工具（symbol={symbol}，interval={interval}，limit={limit}）。',
  indicators: '指标复算：若已挂载 {tool} 工具，可同参数直接复算。',
  truncated: '以下内联最近 {inlined} 根（共 {count} 根），更早部分用上述工具复取。',
  full: '以下为全部 {count} 根的完整内联数据。',
  note: 'time = 各根K线开盘时间；指标空值 = warm-up 未就绪。',
}
