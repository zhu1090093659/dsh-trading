/**
 * 策略契约与回测数据模型（对齐 docs/design/strategy-tab.md §3.1）。
 */
import type { Kline } from '@dshtrading/indicators'

export type { Kline }

export type StrategyHorizon = 'short' | 'swing' | 'long'
export type SignalAction = 'entry' | 'exit'

export interface StrategySignal {
  /** bars 下标：信号在 bars[i] 收盘确认，engine 按 bars[i+1].open 成交 */
  readonly index: number
  readonly time: number
  readonly action: SignalAction
  /** v1 只有 long/flat 两态（不做做空）；预留词汇避免后续破坏性变更 */
  readonly direction: 'long' | 'flat'
  readonly price: number      // 确认时收盘价（展示用；成交价由 engine 决定）
  readonly reason: string     // 人话解释，UI 直接展示（如 'EMA20 上穿 EMA60'；zh 单语）
  /** reason 的词典键（client-ui-strategies 词典约定 strat.<id>.reason.<kind>），
   *  视图按当前语言渲染 t(reasonKey, reasonParams)；缺省回退 reason 原文。 */
  readonly reasonKey?: string
  /** reasonKey 的 {placeholder} 插值参数（数值/枚举，与语言无关）。 */
  readonly reasonParams?: Readonly<Record<string, string | number>>
}

export interface StrategyParamSpec {
  readonly key: string
  readonly label: string
  readonly default: number
  readonly min: number
  readonly max: number
  readonly step: number
}

export interface StrategyDefinition {
  readonly id: string            // 稳定词汇，如 'donchian-breakout'
  readonly horizon: StrategyHorizon
  readonly name: string
  readonly summary: string       // 一句话思路
  readonly params: readonly StrategyParamSpec[]
  /** 纯函数：无 IO/随机/全局态；同一输入必须同一输出（回测确定性） */
  compute(bars: readonly Kline[], params: Readonly<Record<string, number>>): StrategySignal[]
}

export interface TradeRecord {
  readonly entryIndex: number
  readonly entryTime: number
  readonly entryPrice: number
  readonly exitIndex: number
  readonly exitTime: number
  readonly exitPrice: number
  readonly returnPercent: number // 扣除手续费后的净收益率 %，如 5.2 代表 +5.2%
  readonly profit: number        // 绝对金额盈亏
  readonly holdingBars: number   // 持仓 K 线根数
  readonly exitReason: string    // 平仓原因（zh 单语原文，回退用）
  /** exitReason 的词典键 + 插值参数（来自离场 signal 的 reasonKey/Params）。 */
  readonly exitReasonKey?: string
  readonly exitReasonParams?: Readonly<Record<string, string | number>>
}

export interface EquityPoint {
  readonly time: number
  readonly equity: number        // 账户净值
  readonly drawdownPercent: number // 距离历史最高点的回撤 %（负数或 0，如 -8.5 代表 -8.5%）
}

export interface BacktestMetrics {
  readonly totalReturn: number   // 累计收益率 %
  readonly cagr: number          // 复合年化收益率 %
  readonly maxDrawdown: number   // 最大回撤 %（负数或 0，如 -15.4 代表 -15.4%）
  readonly sharpe: number        // 夏普比率（年化）
  readonly winRate: number       // 胜率 %（盈利交易笔数 / 总交易笔数 * 100）
  readonly profitFactor: number  // 盈亏比（总盈利金额 / 总亏损金额；若无亏损且有盈利返回 Infinity，无交易返回 0）
  readonly tradeCount: number    // 交易总笔数
  readonly exposure: number      // 市场暴露度 %（持仓周期占总回测周期比例）
}

export interface BacktestResult {
  readonly signals: readonly StrategySignal[]
  readonly trades: readonly TradeRecord[]
  readonly equity: readonly EquityPoint[]
  readonly metrics: BacktestMetrics
  readonly initialCapital: number
  readonly finalCapital: number
}

export interface BacktestOptions {
  readonly initialCapital?: number // 默认 100,000
  readonly feeRate?: number        // 单边费率，默认 0.001（千分之一）
  readonly slippage?: number       // 滑点比例或点数，默认 0
}
