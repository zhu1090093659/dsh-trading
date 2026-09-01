/**
 * 对话内富卡片（issue #34 / P5 §5.5）：tool.call.toolview keyed slot 视图。
 *
 * - StrategyBacktestCard（key = strategy_backtest）：权益曲线 sparkline +
 *   8 指标 mini 卡 + 标的/区间摘要；
 * - StrategyAuthorCard（key = strategy_author）：校验结果（成功=参数摘要，
 *   失败=原因高亮）。
 *
 * 契约：settled 前返回 null（回落通用工具行）；解析失败同样返回 null——
 * keyed slot 不接管时官方 ToolRow 原样渲染，卡片坏了不吞工具结果。
 */
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { parseStrategyBacktestPayload, parseStrategyAuthorText, type ParsedBacktestCard } from './toolview-parse.ts'
import css from './toolview.module.css'

/** 从 owner.block 取（argsRaw, result 文本）。RunningToolCall 无 result → null。 */
function readCall(block: ToolCallOwnerProps['block']): { argsRaw: string; resultText: string | null; isError: boolean } {
  if (block.kind === 'tool-result') {
    const text = block.content
      .map(part => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('')
    return { argsRaw: block.call?.argsRaw ?? '', resultText: text, isError: block.isError }
  }
  return { argsRaw: block.argsRaw ?? '', resultText: null, isError: false }
}

function fmt(value: number | null, suffix = '', plus = false): string {
  if (value === null) return '--'
  const sign = value > 0 && plus ? '+' : ''
  return `${sign}${value.toFixed(2)}${suffix}`
}

/** 迷你权益曲线：纯 SVG polyline（卡片场景免 lightweight-charts 重量）。 */
function EquitySparkline({ values, isPositive }: { values: number[]; isPositive: boolean }) {
  if (values.length < 2) return null
  let min = values[0] as number
  let max = values[0] as number
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  const width = 560
  const height = 72
  const span = max - min
  const step = width / (values.length - 1)
  const points = values
    .map((value, index) => {
      const x = index * step
      const y = span === 0 ? height / 2 : (1 - (value - min) / span) * (height - 6) + 3
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const stroke = isPositive ? 'var(--dsv-up, #e64545)' : 'var(--dsv-down, #2ba471)'
  return (
    <svg className={css.spark} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const METRIC_CELL: ReadonlyArray<{ key: keyof ParsedBacktestCard; label: string; suffix?: string; plus?: boolean }> = [
  { key: 'totalReturn', label: '累计收益率', suffix: '%', plus: true },
  { key: 'cagr', label: '年化 (CAGR)', suffix: '%', plus: true },
  { key: 'maxDrawdown', label: '最大回撤', suffix: '%' },
  { key: 'sharpe', label: '夏普' },
  { key: 'winRate', label: '胜率', suffix: '%' },
  { key: 'profitFactor', label: '盈亏比' },
  { key: 'tradeCount', label: '交易笔数' },
  { key: 'exposure', label: '暴露度', suffix: '%' },
]

/** strategy_backtest 卡：头部（策略名 + 标的 + 区间）+ sparkline + 8 指标 mini 网格。 */
export function StrategyBacktestCard({ block }: ToolCallOwnerProps) {
  const call = readCall(block)
  if (call.isError || call.resultText === null) return null
  const payload = parseStrategyBacktestPayload(call.resultText)
  if (payload === null) return null

  return (
    <div className={css.card} data-dshtrading-toolview="strategy-backtest">
      <div className={css.head}>
        <span className={css.title}>{payload.name}</span>
        <span className={css.chip}>{payload.symbol}</span>
        <span className={css.chip}>{payload.market}</span>
        <span className={css.chip}>{payload.interval}</span>
        {payload.barsTested !== null && <span className={css.meta}>{payload.barsTested} bars</span>}
      </div>
      <EquitySparkline values={payload.equityValues} isPositive={payload.isPositive} />
      <div className={css.metrics}>
        {METRIC_CELL.map(cell => (
          <div key={cell.key} className={css.metric}>
            <span className={css.metricLabel}>{cell.label}</span>
            <span
              className={css.metricValue}
              data-tone={cell.key === 'totalReturn' || cell.key === 'cagr' ? (payload[cell.key] as number | null) >= 0 ? 'up' : 'down' : undefined}
            >
              {fmt(payload[cell.key] as number | null, cell.suffix ?? '', cell.plus === true)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** strategy_author 卡：成功 = 标题 + id/horizon/参数摘要；失败 = 原因高亮。 */
export function StrategyAuthorCard({ block }: ToolCallOwnerProps) {
  const call = readCall(block)
  if (call.resultText === null) return null
  const parsed = parseStrategyAuthorText(call.resultText)
  if (parsed === null) return null

  if (!parsed.ok) {
    return (
      <div className={css.card} data-dshtrading-toolview="strategy-author" data-ok="false">
        <div className={css.head}>
          <span className={css.title}>策略校验未通过</span>
        </div>
        <div className={css.reason}>{parsed.reason}</div>
      </div>
    )
  }
  return (
    <div className={css.card} data-dshtrading-toolview="strategy-author" data-ok="true">
      <div className={css.head}>
        <span className={css.title}>{parsed.title}</span>
        <span className={css.chip}>{parsed.id}</span>
        <span className={css.chip}>{parsed.horizon}</span>
      </div>
      {parsed.params !== '' && <div className={css.params}>{parsed.params}</div>}
    </div>
  )
}