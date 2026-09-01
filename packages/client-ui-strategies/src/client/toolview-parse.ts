/**
 * toolview 富卡片的数据解析（issue #34 / P5 §5.5）。
 *
 * 工具输出面（host 半 strategies/plugin）：
 * - strategy_backtest → JSON 串（ok/strategy/market/symbol/interval/metrics/
 *   trades/equity/initialCapital/finalCapital）；
 * - strategy_author → 人读文本（成功「[strategy_author] Successfully authored…」
 *   或失败「[strategy_author] Validation failed: …」）。
 *
 * 解析全部防御式：call 块来自 wire，字段可能缺失/类型漂移——失败返回 null，
 * 卡片回落到通用工具行（keyed slot 返回 null 时不接管渲染）。
 */

/** strategy_backtest 输出的 metrics 面（数值可能缺失）。 */
export interface BacktestMetricsLike {
  totalReturn?: unknown
  cagr?: unknown
  maxDrawdown?: unknown
  sharpe?: unknown
  winRate?: unknown
  profitFactor?: unknown
  tradeCount?: unknown
  exposure?: unknown
}

export interface BacktestPayloadLike {
  ok?: unknown
  strategy?: { id?: unknown; name?: unknown; horizon?: unknown }
  market?: unknown
  symbol?: unknown
  interval?: unknown
  barsTested?: unknown
  metrics?: BacktestMetricsLike
  equity?: Array<{ time?: unknown; equity?: unknown }>
  initialCapital?: unknown
  finalCapital?: unknown
}

export interface ParsedBacktestCard {
  name: string
  symbol: string
  market: string
  interval: string
  barsTested: number | null
  totalReturn: number | null
  cagr: number | null
  maxDrawdown: number | null
  sharpe: number | null
  winRate: number | null
  profitFactor: number | null
  tradeCount: number | null
  exposure: number | null
  /** 权益曲线数值序列（sparkline 输入；坏点剔除）。 */
  equityValues: number[]
  isPositive: boolean
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 从 ToolCallBlock（settled tool-result）取文本输出并解析 backtest 载荷。 */
export function parseStrategyBacktestPayload(raw: unknown): ParsedBacktestCard | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let wire: BacktestPayloadLike
  try {
    wire = JSON.parse(raw) as BacktestPayloadLike
  } catch {
    return null
  }
  if (wire === null || typeof wire !== 'object' || wire.ok !== true) return null
  const metrics = (wire.metrics ?? {}) as BacktestMetricsLike
  const equityValues: number[] = []
  if (Array.isArray(wire.equity)) {
    for (const point of wire.equity) {
      const value = asNumber((point as { equity?: unknown })?.equity)
      if (value !== null) equityValues.push(value)
    }
  }
  const totalReturn = asNumber(metrics.totalReturn)
  return {
    name: asString((wire.strategy as { name?: unknown } | undefined)?.name, '—'),
    symbol: asString(wire.symbol, '—'),
    market: asString(wire.market, '—'),
    interval: asString(wire.interval, '1d'),
    barsTested: asNumber(wire.barsTested),
    totalReturn,
    cagr: asNumber(metrics.cagr),
    maxDrawdown: asNumber(metrics.maxDrawdown),
    sharpe: asNumber(metrics.sharpe),
    winRate: asNumber(metrics.winRate),
    profitFactor: asNumber(metrics.profitFactor),
    tradeCount: asNumber(metrics.tradeCount),
    exposure: asNumber(metrics.exposure),
    equityValues,
    isPositive: totalReturn === null ? false : totalReturn >= 0,
  }
}

export interface ParsedAuthorCard {
  ok: boolean
  /** 策略标题（成功时从文本提取）。 */
  title: string
  /** 策略 id。 */
  id: string
  horizon: string
  /** 参数摘要（fast=20, slow=60 形态）。 */
  params: string
  /** 失败原因（失败时）。 */
  reason: string
}

/**
 * strategy_author 输出是人读文本（host 半刻意如此——失败原因要直接喂模型）。
 * 成功形态：
 *   [strategy_author] Successfully authored strategy "双均线" (id: my-id, horizon: short, params: fast=20). …
 * 失败形态：
 *   [strategy_author] Validation failed: <reason>…
 */
export function parseStrategyAuthorText(raw: unknown): ParsedAuthorCard | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const okMatch = /^\[strategy_author\] Successfully authored strategy "([^"]*)" \(id:\s*([^,]+),\s*horizon:\s*([^,)]+)(?:,\s*params:\s*([^)]*))?\)/.exec(raw)
  if (okMatch !== null) {
    return {
      ok: true,
      title: okMatch[1] ?? '—',
      id: (okMatch[2] ?? '').trim(),
      horizon: (okMatch[3] ?? '').trim(),
      params: (okMatch[4] ?? '').trim(),
      reason: '',
    }
  }
  const failMatch = /^\[strategy_author\] Validation failed:\s*([\s\S]+)$/.exec(raw)
  if (failMatch !== null) {
    return {
      ok: false,
      title: '—',
      id: '',
      horizon: '',
      params: '',
      reason: (failMatch[1] ?? '').trim(),
    }
  }
  return null
}