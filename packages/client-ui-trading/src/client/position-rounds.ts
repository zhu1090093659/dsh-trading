/**
 * 持仓回合撮合引擎（2026-09-06 已实现盈亏）——纯函数，vitest 重点。
 *
 * 从成交流水（fills）按 FIFO 撮合出「开仓→清零」的持仓回合（round），回答
 * 「平仓后再开仓，能否回看上一轮盈亏」：每轮回合携带独立的已实现盈亏，
 * 标的维度聚合为历史持仓（已平仓历史分区），全局合计为权益条「已实现」块。
 *
 * 语义定稿：
 * - 净多头流水假设：paper 撮合引擎只开多头、卖出必须足额（无保证金/做空）；
 *   买入开/加仓成批次入栈，卖出按 FIFO 平最老批次；
 * - 回合 = 净持仓从 0 开启、回到 0 关闭的区段；回合内多次部分平仓的已实现
 *   盈亏累加进该回合（对齐交易所「回合盈亏」口径）；
 * - 回合字段：openTs（首笔买入）/ closeTs（清零那笔卖出）/ closedSize（撮合
 *   平掉的数量）/ avgEntry、avgExit（各自加权均价）/ realizedPnl（Σ(卖价−
 *   买价)×量；费用不计——paper 流水 fee 恒 0）；
 * - 分组键为 symbol：旧 paper 流水无 market 字段，跨市场同码在模拟盘罕见，
 *   接受合并；market 取该组最后一笔带 market 的流水（新流水由 paper 撮合
 *   补记，见 paper-trading-store PaperFill）；
 * - 流水不完整（历史窗口外开仓，live 接入时会出现）：卖出匹配不到成本批次
 *   的部分不计盈亏、不计平仓量，回合成色由 UI 文案披露；
 * - 未平仓批次不产生回合——浮盈归 holdings-aggregate 盯市口径负责，两边
 *   合起来才是「已实现 + 浮动」的完整总盈亏。
 */
import type { MarketId } from './types.ts'

/** 引擎输入的最小流水形状（paper fills 结构化兼容，不耦合 api 契约）。 */
export interface RoundFillLike {
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly price: number
  readonly amount: number
  readonly timestamp: number
  readonly market?: MarketId
}

/** 一轮已平仓回合（净持仓 0 → 开 → 清零）。 */
export interface ClosedRound {
  readonly symbol: string
  readonly market: MarketId | undefined
  readonly openTs: number
  readonly closeTs: number
  readonly closedSize: number
  readonly avgEntry: number
  readonly avgExit: number
  readonly realizedPnl: number
}

/** 标的维度历史（已平仓历史分区的一行；rounds 按平仓时间升序）。 */
export interface SymbolRoundHistory {
  readonly key: string
  readonly symbol: string
  readonly market: MarketId | undefined
  readonly rounds: readonly ClosedRound[]
  readonly realizedPnl: number
  /** 已实现成本 = Σ(avgEntry × closedSize)，比率分母。 */
  readonly realizedCost: number
  readonly lastCloseTs: number
}

export interface RoundsOutcome {
  /** 全部回合（按平仓时间升序）。 */
  readonly rounds: readonly ClosedRound[]
  /** 按标的分组（最近平仓的标在前）。 */
  readonly bySymbol: readonly SymbolRoundHistory[]
  readonly totalRealizedPnl: number
  readonly totalRealizedCost: number
}

interface CostLot {
  readonly price: number
  size: number
  readonly ts: number
}

/** 回合在攒过程中的可变状态（只在引擎内部使用）。 */
interface RoundAccumulator {
  openTs: number
  entryCost: number
  entrySize: number
  exitProceeds: number
  exitSize: number
  realizedPnl: number
  closeTs: number
}

/**
 * FIFO 撮合主入口。fills 顺序不敏感（内部按 timestamp 升序稳定排序——paper
 * store 存储为最新在前）。
 */
export function derivePositionRounds(fills: readonly RoundFillLike[]): RoundsOutcome {
  const chronological = [...fills].sort((a, b) => a.timestamp - b.timestamp)
  const lotsBySymbol = new Map<string, CostLot[]>()
  const roundsBySymbol = new Map<string, ClosedRound[]>()
  const marketBySymbol = new Map<string, MarketId>()
  const openRoundBySymbol = new Map<string, RoundAccumulator>()

  for (const fill of chronological) {
    if (fill.market !== undefined) marketBySymbol.set(fill.symbol, fill.market)
    if (fill.side === 'buy') {
      const lots = lotsBySymbol.get(fill.symbol) ?? []
      lots.push({ price: fill.price, size: fill.amount, ts: fill.timestamp })
      lotsBySymbol.set(fill.symbol, lots)
      const round = openRoundBySymbol.get(fill.symbol) ??
        { openTs: fill.timestamp, entryCost: 0, entrySize: 0, exitProceeds: 0, exitSize: 0, realizedPnl: 0, closeTs: fill.timestamp }
      round.entryCost += fill.price * fill.amount
      round.entrySize += fill.amount
      openRoundBySymbol.set(fill.symbol, round)
      continue
    }
    // 卖出：FIFO 平最老批次；无批次（历史窗口外）匹配不到的部分不计。
    const lots = lotsBySymbol.get(fill.symbol)
    if (lots === undefined || lots.length === 0) continue
    let remaining = fill.amount
    let matchedProceeds = 0
    let matchedSize = 0
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0] as CostLot
      const matched = Math.min(remaining, lot.size)
      const round = openRoundBySymbol.get(fill.symbol)!
      round.realizedPnl += (fill.price - lot.price) * matched
      matchedProceeds += fill.price * matched
      matchedSize += matched
      remaining -= matched
      if (lot.size <= matched) lots.shift()
      else lots[0] = { ...lot, size: lot.size - matched }
    }
    const round = openRoundBySymbol.get(fill.symbol)
    if (round === undefined) continue
    round.exitProceeds += matchedProceeds
    round.exitSize += matchedSize
    round.closeTs = fill.timestamp
    if (lots.length === 0) {
      lotsBySymbol.delete(fill.symbol)
      const closed: ClosedRound = {
        symbol: fill.symbol,
        market: marketBySymbol.get(fill.symbol),
        openTs: round.openTs,
        closeTs: round.closeTs,
        closedSize: round.exitSize,
        avgEntry: round.entrySize > 0 ? round.entryCost / round.entrySize : 0,
        avgExit: round.exitSize > 0 ? round.exitProceeds / round.exitSize : 0,
        realizedPnl: round.realizedPnl,
      }
      const list = roundsBySymbol.get(fill.symbol) ?? []
      list.push(closed)
      roundsBySymbol.set(fill.symbol, list)
      openRoundBySymbol.delete(fill.symbol)
    }
  }

  // 攒各标的分组（只含已平仓回合；有未平仓批次但无完整回合的标的不出现）。
  const bySymbol: SymbolRoundHistory[] = []
  for (const [symbol, rounds] of roundsBySymbol) {
    const realizedPnl = rounds.reduce((sum, r) => sum + r.realizedPnl, 0)
    const realizedCost = rounds.reduce((sum, r) => sum + r.avgEntry * r.closedSize, 0)
    bySymbol.push({
      key: symbol,
      symbol,
      market: marketBySymbol.get(symbol),
      rounds,
      realizedPnl,
      realizedCost,
      lastCloseTs: rounds[rounds.length - 1]?.closeTs ?? 0,
    })
  }
  bySymbol.sort((a, b) => b.lastCloseTs - a.lastCloseTs)

  const rounds = bySymbol.flatMap(h => h.rounds).sort((a, b) => a.closeTs - b.closeTs)
  return {
    rounds,
    bySymbol,
    totalRealizedPnl: bySymbol.reduce((sum, h) => sum + h.realizedPnl, 0),
    totalRealizedCost: bySymbol.reduce((sum, h) => sum + h.realizedCost, 0),
  }
}

/**
 * paper 模拟池按 USD/USDT 计价，回合盈亏先按 USD 记账，展示时折算基准币。
 * fx 缺席或缺 USD 汇率 → undefined（权益条整块隐藏，不编造）。
 */
export function convertUsdToBase(value: number, fx: { readonly base: string; readonly rates: Record<string, number> } | undefined): number | undefined {
  if (fx === undefined) return undefined
  if (fx.base === 'USD') return value
  const rate = fx.rates.USD
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? value * rate : undefined
}
