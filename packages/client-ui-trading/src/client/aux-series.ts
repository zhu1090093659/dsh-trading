/**
 * 指标外部序列的客户端接线（契约 §5）：宿主按 definition.aux 声明的键预取日频
 * 序列，取不到（undefined / 空序列）即隐藏该副图 pane——「空 ≠ 0」，不画零线。
 *
 * 为什么单独成模块：QuoteStage 的取数与调度要留下三条可回归的纯逻辑点——
 * 「取 holdRatio 口径」「无数据则整体隐藏」「换标的丢弃在途应答」；渲染层在 jsdom
 * 里挂不起图表（lightweight-charts 需 canvas），纯函数是唯一能钉住行为的落点。
 */
import type { AuxBarSeriesMap, AuxPoint, AuxSeriesKey, AuxSeriesMap, IndicatorDefinition, IndicatorInstance } from '@dshtrading/indicators'
import { isDefinitionAvailableOn } from '@dshtrading/indicators'
import type { EtfRescueHistory, SouthboundHoldingHistory } from '@dshtrading/api'
import type { ActiveBuyHistory } from './api.ts'
import type { MarketLocaleKey } from './contract.ts'
import type { MarketId } from './types.ts'

/** 港股通持股比例的外部序列键（冻结字面量，与预置 definition.aux 同名）。 */
export const HK_CONNECT_HOLDING_KEY: AuxSeriesKey = 'hk-connect-holding'
export const CN_ACTIVE_BUY_KEY: AuxSeriesKey = 'cn-active-buy'
/**
 * 「ETF 托底」副图的两条外部序列键（冻结字面量，与预置 cn-etf-rescue 的 definition.aux
 * 同名）：深度 = 该标的所属宽基指数篮子的 ETF 渗透率，广度 = 除沪深300 外六指数合计。
 * 两条键的数据来自**同一次** GET /dshtrading/api/etf-rescue 应答（见 createEtfRescueMemo）。
 */
export const CN_ETF_RESCUE_DEPTH_KEY: AuxSeriesKey = 'cn-etf-rescue-depth'
export const CN_ETF_RESCUE_BREADTH_KEY: AuxSeriesKey = 'cn-etf-rescue-breadth'
export type ActiveBuyFetcher = (market: MarketId, symbol: string) => Promise<ActiveBuyHistory | undefined>
export type EtfRescueFetcher = (market: MarketId, symbol: string) => Promise<EtfRescueHistory | undefined>

/**
 * 外部序列取数缝：键之外的取数实现由调用方注入（生产传 api.ts 的
 * fetchSouthboundHoldings）。失败以 undefined 表示，不抛——单个序列取不到只影响
 * 依赖它的指标，不牵连主图与其它副图。
 */
export type HoldingsFetcher = (market: MarketId, symbol: string) => Promise<SouthboundHoldingHistory | undefined>

/**
 * 港股通持股历史 → 外部序列。口径冻结为 holdRatio（持股比例，百分比数值）；
 * 取数失败或空 points 一律 undefined（标的不在港股通范围时上游返回空序列，
 * 语义与失败同为「没有可画的数据」）。
 */
export function southboundHoldingsToAuxPoints(history: SouthboundHoldingHistory | undefined): readonly AuxPoint[] | undefined {
  if (history === undefined) return undefined
  const points = history.points.map(point => ({ date: point.date, value: point.holdRatio }))
  return points.length === 0 ? undefined : points
}

/**
 * 「ETF 托底」历史 → 外部序列：同一份应答按**键**取不同口径（深度/广度），所以两条
 * 键天然共享一次取数。取数失败、空 points、或键不在本指标声明范围 → undefined
 * （空 ≠ 0：消费方据此整体隐藏副图，不画零线）。
 */
export function etfRescueToAuxPoints(history: EtfRescueHistory | undefined, key: AuxSeriesKey): readonly AuxPoint[] | undefined {
  if (history === undefined || history.points.length === 0) return undefined
  if (key === CN_ETF_RESCUE_DEPTH_KEY) return history.points.map(point => ({ date: point.date, value: point.depthPct }))
  if (key === CN_ETF_RESCUE_BREADTH_KEY) return history.points.map(point => ({ date: point.date, value: point.breadthPct }))
  return undefined
}

/**
 * 请求级 memo（同键 in-flight 去重）：两条 ETF 托底键读的是同一个端点，把 memo 之后
 * 的取数函数交给一次 chart 刷新里的两次 loadAuxSeriesSnapshot，对两条键只发一次请求。
 *
 * 生命周期归调用方：useAuxSeries 每次刷新建一个 memo，于是「换标的/换指标组合」自然
 * 换一份缓存——旧标的的在途应答不会喂给新标的（竞态守卫仍在 useAuxSeries 里，这一层
 * 只负责去重，不负责跨请求复用）。fetcher 缺席 → 恒 undefined，等于该能力未接线。
 */
export function createEtfRescueMemo(fetcher: EtfRescueFetcher | undefined): EtfRescueFetcher {
  const inFlight = new Map<string, Promise<EtfRescueHistory | undefined>>()
  return (market, symbol) => {
    if (fetcher === undefined) return Promise.resolve(undefined)
    const key = `${market}:${symbol}`
    const hit = inFlight.get(key)
    if (hit !== undefined) return hit
    const pending = fetcher(market, symbol)
    inFlight.set(key, pending)
    return pending
  }
}

export function activeBuyToAuxPoints(history: ActiveBuyHistory | undefined): readonly AuxPoint[] | undefined {
  if (history === undefined || history.points.length === 0) return undefined
  return history.points.map(point => ({ date: Date.parse(`${point.date}T00:00:00Z`), value: point.netSharePct }))
}

/**
 * Asia/Shanghai（UTC+8，无夏令时），起止分钟均包含。
 * 尾段延至 15:12，覆盖 15:05 采集任务落盘后的五分钟复取，使 live 收敛为 close。
 * 15:00 收盘至 close 行落盘前仍取 live 点、显示「盘中」（数值即当日终值读数）；
 * 这段差异是有意的，不按时间猜徽标：节假日无 live 点，数据门控保证徽标不误显。
 */
export function isCnPollingWindow(nowMs: number): boolean {
  const shanghai = new Date(nowMs + 8 * 60 * 60 * 1000)
  const day = shanghai.getUTCDay()
  const minute = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes()
  return day >= 1 && day <= 5 && ((minute >= 9 * 60 + 25 && minute <= 11 * 60 + 32) || (minute >= 12 * 60 + 58 && minute <= 15 * 60 + 12))
}

export interface AuxSeriesSnapshot {
  readonly points: readonly AuxPoint[] | undefined
  readonly live: boolean
}

export async function loadAuxSeriesSnapshot(
  key: AuxSeriesKey,
  market: MarketId,
  symbol: string,
  fetchHoldings: HoldingsFetcher,
  fetchActiveBuy?: ActiveBuyFetcher,
  fetchEtfRescue?: EtfRescueFetcher,
): Promise<AuxSeriesSnapshot> {
  // 「ETF 托底」两条键：同一次应答按口径拆分，日频存量占比不是盘中量，live 恒 false。
  if (key === CN_ETF_RESCUE_DEPTH_KEY || key === CN_ETF_RESCUE_BREADTH_KEY) {
    if (fetchEtfRescue === undefined) return { points: undefined, live: false }
    const history = await fetchEtfRescue(market, symbol).catch(() => undefined)
    return { points: etfRescueToAuxPoints(history, key), live: false }
  }
  if (key !== HK_CONNECT_HOLDING_KEY && key !== CN_ACTIVE_BUY_KEY) return { points: undefined, live: false }
  if (key === CN_ACTIVE_BUY_KEY) {
    const history = await fetchActiveBuy?.(market, symbol).catch(() => undefined)
    return { points: activeBuyToAuxPoints(history), live: history?.points.some(point => point.phase === 'live') ?? false }
  }
  const history = await fetchHoldings(market, symbol).catch(() => undefined)
  return { points: southboundHoldingsToAuxPoints(history), live: false }
}

export async function loadAuxSeries(
  key: AuxSeriesKey,
  market: MarketId,
  symbol: string,
  fetchHoldings: HoldingsFetcher,
  fetchActiveBuy?: ActiveBuyFetcher,
  fetchEtfRescue?: EtfRescueFetcher,
): Promise<readonly AuxPoint[] | undefined> {
  return (await loadAuxSeriesSnapshot(key, market, symbol, fetchHoldings, fetchActiveBuy, fetchEtfRescue)).points
}

/**
 * 当前需要预取的外部序列键（去重、保持首现序）：只统计在当前市场可用的
 * definition（决策 5 白名单）所声明的键。无声明 = 无需取数。
 */
export function requiredAuxKeys(
  instances: readonly IndicatorInstance[],
  market: MarketId | undefined,
  getDefinition: (id: string) => IndicatorDefinition | undefined,
): AuxSeriesKey[] {
  const keys: AuxSeriesKey[] = []
  for (const instance of instances) {
    const definition = getDefinition(instance.id)
    if (definition === undefined || !isDefinitionAvailableOn(definition, market)) continue
    for (const key of definition.aux ?? []) {
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

/**
 * 该 definition 的外部序列是否已就绪：未声明 aux → 恒真（走 compute）；声明了 →
 * 每个键都要有**非空**序列。空数组按未取到处理（决策 3：整体隐藏副图，不是画空线）。
 */
export function auxSeriesReady(definition: Pick<IndicatorDefinition, 'aux'>, series: AuxSeriesMap): boolean {
  const keys = definition.aux ?? []
  if (keys.length === 0) return true
  return keys.every(key => (series[key]?.length ?? 0) > 0)
}

/**
 * 未就绪时的**空态文案**归属：由声明键（数据域身份）决定，不由 definition.id 决定——
 * 同一个键上的多个 definition（含用户自定义指标）说同一件事，按 id 分派就得每加一个
 * 定义补一条文案，而且自定义定义根本不在名册里。多键定义取首个声明键（当前无此形态），
 * 未登记的键回落通用文案（见 dispatch 的占位组）。
 */
export function auxEmptyNoticeKey(key: AuxSeriesKey): MarketLocaleKey {
  if (key === HK_CONNECT_HOLDING_KEY) return 'indicator.auxEmpty.hkConnectHolding'
  if (key === CN_ACTIVE_BUY_KEY) return 'indicator.auxEmpty.cnActiveBuy'
  // 同一块副图的两条键各说各话：深度缺 = 这个标的没映射到宽基指数（或份额未采集），
  // 广度缺 = 六指数篮子整体取不到——两句话的排查方向不同，不能共用一条。
  if (key === CN_ETF_RESCUE_DEPTH_KEY) return 'indicator.auxEmpty.cnEtfRescueDepth'
  if (key === CN_ETF_RESCUE_BREADTH_KEY) return 'indicator.auxEmpty.cnEtfRescueBreadth'
  return 'indicator.auxEmpty.generic'
}

/**
 * 该 definition 的逐根序列是否齐备（barAux 通道）：声明非空，且每个声明键的数组长度
 * 都严格等于 bars 根数。与 auxSeriesReady 的语义差异是有意的——aux「取不到就整体隐藏
 * 实例」，barAux「取不到就回落 compute，实例照常渲染」：档位色缺失只该退化成没有档位
 * 色的柱，没有理由把整个副图藏掉。长度不符一律按未就绪处理（不截断、不补齐）：逐根
 * 通道按下标对齐，错位着色比不着色更坏。
 */
export function barAuxSeriesReady(
  definition: Pick<IndicatorDefinition, 'barAux'>,
  series: AuxBarSeriesMap,
  barCount: number,
): boolean {
  const keys = definition.barAux ?? []
  if (keys.length === 0 || barCount === 0) return false
  return keys.every(key => series[key]?.length === barCount)
}

/** 在途取数句柄：只有自己的请求键仍是当前键时 isCurrent() 为真。 */
export interface AuxRequestHandle {
  readonly key: string
  isCurrent(): boolean
}

/**
 * 每次 start 都生成新代际，换标的后再切回同一键也不能复活旧应答。
 */
export function createAuxRequestGuard(): { start: (key: string) => AuxRequestHandle } {
  let generation = 0
  return {
    start(key) {
      const requestGeneration = ++generation
      return { key, isCurrent: () => generation === requestGeneration }
    },
  }
}
