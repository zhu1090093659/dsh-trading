/**
 * 指标适用范围的 client 半纯逻辑（GUI 选择 → 持久化条目）。
 *
 * 读侧判据（是否应用）在 @dshtrading/indicators 的 isInstanceApplicableOn——本模块
 * 只负责写入侧的两个 GUI 约束：可配置市场集的顺序，以及「全部级别应用」的归一。
 *
 * 归一规则（2026-10-09 用户确认）：某市场「启用 + 已选级别 = 该市场全部支持级别」时
 * 删除该条目，落回字段级「缺席 = 全部级别应用」——这样上游后续新增该市场的级别时
 * 自动跟随，不会困在旧快照里。其它形态（关闭市场、部分选择、空选择）原样保留条目。
 * **空选择绝不归一为全部**：用户清空级别必须落盘为「未选择级别」（该市场不应用）。
 */
import type { IndicatorInstance, IndicatorMarketScope } from '@dshtrading/indicators'
import { isInstanceApplicableOn } from '@dshtrading/indicators'
import type { MarketId } from './types.ts'
import { MARKET_INTERVALS } from './store.ts'

/** 适用范围面板的市场行顺序（与系统支持的市场词汇一致；不新增市场或级别支持）。 */
export const SCOPE_MARKETS = Object.keys(MARKET_INTERVALS) as MarketId[]

/**
 * 把 GUI 选择归一为持久化条目：启用且选中该市场全部支持级别 → undefined（删除条目，
 * 落回全部级别应用）；否则原样返回（含空选择——「未选择级别」必须落盘）。
 */
export function normalizeMarketScope(
  scene: IndicatorMarketScope,
  supported: readonly string[],
): IndicatorMarketScope | undefined {
  if (scene.enabled && supported.length > 0
    && scene.intervals.length === supported.length
    && supported.every(level => scene.intervals.includes(level))) {
    return undefined
  }
  return scene
}

/** 某市场支持的全部级别（图表可提供的周期；未知市场返回空表）。 */
export function supportedIntervals(market: MarketId): string[] {
  return MARKET_INTERVALS[market] ?? []
}

/**
 * 图表渲染集的唯一判据：指标自身已启用（在名册）+ 当前市场已开启 + 当前 K 线级别
 * 已选中，三者同时满足才参与计算与绘制。主图叠加与副图指标共用本集合——TvChart
 * 按本集合收缩 series（副图空 pane 由 lightweight-charts 自动摘除），故切回适用
 * 市场/级别即自动恢复，且不残留绘制。
 *
 * 入参 instances 应已按标的可见性（symbol visibility）过滤（QuoteStage 的
 * visibleInstances）；本函数只叠加适用范围这一层。
 */
export function selectApplicableInstances(
  instances: readonly IndicatorInstance[],
  market: MarketId | undefined,
  interval: string | undefined,
): IndicatorInstance[] {
  return instances.filter(instance => isInstanceApplicableOn(instance, market, interval))
}
