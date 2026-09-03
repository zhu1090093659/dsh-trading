/**
 * 纯函数回测执行器（对齐 docs/design/strategy-tab.md §3.2）。
 *
 * 保证确定性、无副作用、浏览器端与 Node 端同构执行。
 */
import type { Kline } from '@dshtrading/indicators'
import type {
  BacktestMetrics,
  BacktestOptions,
  BacktestResult,
  EquityPoint,
  StrategyDefinition,
  StrategySignal,
  TradeRecord,
} from './types.ts'

const DEFAULT_INITIAL_CAPITAL = 100_000
const DEFAULT_FEE_RATE = 0.001 // 千分之一单边手续费
const MS_PER_DAY = 86_400_000
const MS_PER_YEAR = 365.25 * MS_PER_DAY

/** 推断一年的 bar 根数（根据相邻 K 线平均时间间隔）。 */
function estimateBarsPerYear(bars: readonly Kline[]): number {
  if (bars.length < 2) return 250
  const totalSpan = bars[bars.length - 1].openTime - bars[0].openTime
  if (totalSpan <= 0) return 250
  const avgInterval = totalSpan / (bars.length - 1)
  if (avgInterval <= 0) return 250
  const barsPerYear = MS_PER_YEAR / avgInterval
  return Math.max(1, Math.min(barsPerYear, 365 * 1440))
}

export function run(
  bars: readonly Kline[],
  strategy: StrategyDefinition,
  paramsOverride: Record<string, number> = {},
  options: BacktestOptions = {},
): BacktestResult {
  const initialCapital = options.initialCapital ?? DEFAULT_INITIAL_CAPITAL
  const feeRate = options.feeRate ?? DEFAULT_FEE_RATE
  const slippage = options.slippage ?? 0

  if (!bars || bars.length === 0) {
    return {
      signals: [],
      trades: [],
      equity: [],
      metrics: {
        totalReturn: 0,
        cagr: 0,
        maxDrawdown: 0,
        sharpe: 0,
        winRate: 0,
        profitFactor: 0,
        tradeCount: 0,
        exposure: 0,
      },
      initialCapital,
      finalCapital: initialCapital,
    }
  }

  // 1. 合并策略默认参数
  const resolvedParams: Record<string, number> = {}
  for (const p of strategy.params) {
    resolvedParams[p.key] = paramsOverride[p.key] ?? p.default
  }

  // 2. 纯函数计算全部信号
  const signals = strategy.compute(bars, resolvedParams)

  // 3. 构建信号索引映射（每个 bar 产生的最新有效信号）
  const signalMap = new Map<number, StrategySignal>()
  for (const s of signals) {
    if (s.index >= 0 && s.index < bars.length) {
      signalMap.set(s.index, s)
    }
  }

  // 4. 驱动时序回测
  let cash = initialCapital
  let shares = 0
  let position: 'flat' | 'long' = 'flat'
  let entryIndex = -1
  let entryTime = 0
  let entryPrice = 0
  let entryCashCost = 0
  let totalHoldingBars = 0

  const trades: TradeRecord[] = []
  const equityPoints: EquityPoint[] = []
  let peakEquity = initialCapital
  let maxDrawdown = 0

  for (let i = 0; i < bars.length; i++) {
    const currentBar = bars[i]

    // 检查前一根 bar (i - 1) 是否产生了未处理的成交信号（在当前 bar 的 open 执行成交）
    if (i > 0) {
      const prevSignal = signalMap.get(i - 1)
      if (prevSignal) {
        if (prevSignal.action === 'entry' && position === 'flat') {
          // 在当前 bar open 买入
          const rawPrice = currentBar.open
          const executedBuyPrice = rawPrice * (1 + slippage)
          if (executedBuyPrice > 0) {
            const costPerShare = executedBuyPrice * (1 + feeRate)
            shares = cash / costPerShare
            entryCashCost = cash
            cash = 0
            position = 'long'
            entryIndex = i
            entryTime = currentBar.openTime
            entryPrice = executedBuyPrice
          }
        } else if (prevSignal.action === 'exit' && position === 'long') {
          // 在当前 bar open 卖出
          const rawPrice = currentBar.open
          const executedSellPrice = rawPrice * (1 - slippage)
          const gross = shares * executedSellPrice
          const netCash = gross * (1 - feeRate)
          const profit = netCash - entryCashCost
          const returnPercent = ((executedSellPrice / entryPrice) * (1 - feeRate) / (1 + feeRate) - 1) * 100
          const holdingBars = i - entryIndex

          trades.push({
            entryIndex,
            entryTime,
            entryPrice,
            exitIndex: i,
            exitTime: currentBar.openTime,
            exitPrice: executedSellPrice,
            returnPercent,
            profit,
            holdingBars,
            exitReason: prevSignal.reason,
            ...(prevSignal.reasonKey !== undefined ? { exitReasonKey: prevSignal.reasonKey } : {}),
            ...(prevSignal.reasonParams !== undefined ? { exitReasonParams: prevSignal.reasonParams } : {}),
          })

          cash = netCash
          shares = 0
          position = 'flat'
          entryIndex = -1
        }
      }
    }

    if (position === 'long') {
      totalHoldingBars += 1
    }

    // 计算当前 bar 收盘时的估算权益
    let currentEquity: number
    if (position === 'long') {
      const estimatedNetGross = shares * currentBar.close * (1 - feeRate)
      currentEquity = estimatedNetGross
    } else {
      currentEquity = cash
    }

    if (currentEquity > peakEquity) {
      peakEquity = currentEquity
    }
    const currentDrawdown = peakEquity > 0 ? ((currentEquity - peakEquity) / peakEquity) * 100 : 0
    if (currentDrawdown < maxDrawdown) {
      maxDrawdown = currentDrawdown
    }

    equityPoints.push({
      time: currentBar.openTime,
      equity: currentEquity,
      drawdownPercent: currentDrawdown,
    })
  }

  const finalCapital = equityPoints[equityPoints.length - 1]?.equity ?? initialCapital
  const totalReturn = ((finalCapital - initialCapital) / initialCapital) * 100

  // 5. 计算指标
  const tradeCount = trades.length
  const winningTrades = trades.filter((t) => t.profit > 0)
  const winRate = tradeCount > 0 ? (winningTrades.length / tradeCount) * 100 : 0

  const totalWinAmount = trades.filter((t) => t.profit > 0).reduce((sum, t) => sum + t.profit, 0)
  const totalLossAmount = trades.filter((t) => t.profit < 0).reduce((sum, t) => sum + Math.abs(t.profit), 0)
  let profitFactor = 0
  if (totalLossAmount === 0) {
    profitFactor = totalWinAmount > 0 ? Infinity : 0
  } else {
    profitFactor = totalWinAmount / totalLossAmount
  }

  const exposure = bars.length > 0 ? (totalHoldingBars / bars.length) * 100 : 0

  // CAGR
  let cagr = 0
  if (bars.length > 1) {
    const timeSpanMs = bars[bars.length - 1].openTime - bars[0].openTime
    const years = timeSpanMs / MS_PER_YEAR
    if (years > 0.01 && finalCapital > 0) {
      cagr = (Math.pow(finalCapital / initialCapital, 1 / years) - 1) * 100
    } else if (finalCapital <= 0) {
      cagr = -100
    }
  }

  // Sharpe 计算
  let sharpe = 0
  if (equityPoints.length > 1) {
    const returns: number[] = []
    for (let k = 1; k < equityPoints.length; k++) {
      const prev = equityPoints[k - 1].equity
      const curr = equityPoints[k].equity
      if (prev > 0) {
        returns.push((curr - prev) / prev)
      } else {
        returns.push(0)
      }
    }

    if (returns.length > 1) {
      const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1)
      const stdev = Math.sqrt(variance)
      if (stdev > 0) {
        const annualFactor = Math.sqrt(estimateBarsPerYear(bars))
        sharpe = (mean / stdev) * annualFactor
      }
    }
  }

  const metrics: BacktestMetrics = {
    totalReturn,
    cagr,
    maxDrawdown,
    sharpe,
    winRate,
    profitFactor,
    tradeCount,
    exposure,
  }

  return {
    signals,
    trades,
    equity: equityPoints,
    metrics,
    initialCapital,
    finalCapital,
  }
}
