/**
 * ticker 快照 → bar 序列（2026-10-21 自 QuoteStage 抽出，纯函数）。
 *
 * 两个职责，按「末根与快照是否同一市场本地日」分流：
 * 1. **同日**：快照价并进最后一根（close=价格，high/low 取包络，其余字段原样）——
 *    这是本模块抽出前的既有语义，所有级别一致。
 * 2. **末根早于快照日**：只有日线级别补一根「当日未完成」日 K（open=high=low=close=
 *    价格，volume=快照量）。抽出前的实现不判日期、恒并进最后一根，末根不是当日时
 *    会把昨日那根 K 线改错（价格与高低点被今天的价污染），且当日永远不进序列——
 *    以日 K 序列为输入的指标（自建 KDAS 的 Anchored VWAP 自关键日起累到当日）因此
 *    漏掉当日那根。
 *
 * 三条不变量：
 * - **级别由调用处传入**（context.interval），模块不猜：只有 '1d' 才追加，分钟级、
 *   五日级别、周/月线一律只走同日合并——'1w'/'1M' 的 bar 跨多日，补一根按日定义的
 *   bar 进去就是伪造。级别未知（null = 序列还没落地）按非日线处理。
 * - **日期口径只有一份**：市场本地日取 market-time.ts（MARKET_TIMEZONE +
 *   marketLocalDay），交易时点取 market-status.ts（getMarketSessionStatus），本模块
 *   不写第二张时区表或交易时段表。取不到本地日（crypto/global 的 MARKET_TIMEZONE
 *   为 null）即退回同日合并。
 * - **纯函数 + 不可变**：不修改入参数组、不碰时钟（判定时刻只用 ticker.timestamp，
 *   「这一拍的时刻」本来就由快照自带）、无 IO。没有任何变化时返回入参数组引用，让
 *   React 的 setState 走同引用短路，不为一次未变化的合并重算整张图。
 *
 * 与之配套的 restoreFormingBar 覆盖另一半事实：K 线是全量重取落地的（30s resync），
 * 上游缺当日那根时重取会把 ticker 补出来的 bar 抹掉——每拍闪断一次，必须用最近快照复原；
 * 而「按快照价新造」的当日 bar 还得继承上一拍的包络，否则 high/low 每拍塌回当拍价。
 */
import { getMarketSessionStatus } from './market-status.ts'
import { MARKET_TIMEZONE, marketLocalDay } from './market-time.ts'
import { tickerBarMergeable } from './five-day-series.ts'
import type { MarketLocaleKey } from './contract.ts'
import type { Kline, MarketId, Ticker } from './types.ts'

/** 日线级别：只有它才允许补「当日未完成」日 K（见模块头：周/月线不补）。 */
const DAILY_INTERVALS: ReadonlySet<string> = new Set(['1d'])

/**
 * 常规时段的可交易状态白名单。集合竞价与午间休市同属交易日（当日那根在图上该在），
 * 故一并列入；美股盘前/盘后是 market-status.ts 的两个独立态（status.preMarket /
 * status.afterHours），延长时段的价与极值不属于常规日 K——写进日 K 的最高/最低会让按
 * (H+L+C)/3 取典型价的指标（KDAS 的 Anchored VWAP）吃到延长时段，故排除。
 * 周末休市与开市前/收市后（cn/hk 均为 status.closed）同样不在白名单内。
 */
const TRADABLE_STATUS: ReadonlySet<MarketLocaleKey> = new Set(['status.trading', 'status.auction', 'status.midday'])

/** 一根日 K 的名义时长。 */
const DAY_MS = 86_400_000

export interface TickerBarContext {
  /** 标的所属市场（决定时区/交易时段口径）。 */
  readonly market: MarketId
  /** 图上这条 bar 序列的级别（调用处传入；null = 还没落地，按非日线处理）。 */
  readonly interval: string | null
}

/** 最近一次 ticker 快照与它本次的取数源（全量重取落地时的复原依据）。 */
export interface TickerSnapshot {
  readonly ticker: Ticker
  /** 该快照的取数源；undefined = 未标注（与 bar 源未知同义，按「还不确定」处理）。 */
  readonly source: string | undefined
}

/** 该快照时刻是否落在常规时段的可交易时点（见 TRADABLE_STATUS）。 */
function tradableAt(market: MarketId, at: number): boolean {
  return TRADABLE_STATUS.has(getMarketSessionStatus(market, at).statusKey)
}

/**
 * 市场本地日历日 → 该日的行情日界（UTC 零点 epoch ms）。
 *
 * 不用「本地零点」是因为 KDAS 等日级指标按 `new Date(openTime).getUTC*` 读交易日，
 * 而本仓日 K 的 openTime 口径（tencent 的 "UTC 当日零点锚定，行情日界语义"、yahoo 的
 * 当日开盘时刻）共享同一条不变量：**openTime 的 UTC 日期 == 市场本地日**。本地零点
 * 会让 cn/hk 落到前一 UTC 日期，把指标眼里的交易日整体挪一天。
 */
function dayAnchorMs(localDay: string): number {
  const parts = localDay.split('-')
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
}

/** 同日语义：快照价并进最后一根；无变化（含价格已在区间内）返回原数组。 */
function mergeIntoLast(prev: Kline[], price: number): Kline[] {
  const last = prev[prev.length - 1]
  if (last === undefined) return prev
  if (last.close === price && last.high >= price && last.low <= price) return prev
  const merged: Kline = {
    ...last,
    close: price,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
  }
  return [...prev.slice(0, -1), merged]
}

/**
 * 用一帧 ticker 快照推进 bar 序列。无变化时返回 prev 本身（同引用）。
 *
 * 判定顺序（每一档都是终态，不再往下走）：
 * 1. 空序列 / 快照价非有限正数 / 快照时间无效 → 原样返回。
 * 2. 非日线级别，或该市场没有市场本地日（crypto/global）→ 同日合并语义。
 * 3. 末根本地日 == 快照本地日 → 同日合并。
 * 4. 末根本地日 > 快照本地日（时钟/数据异常）→ 原样返回，不动任何 bar。
 * 5. 末根本地日 < 快照本地日：常规时段可交易时点才补一根当日未完成日 K；周末/开市前/
 *    收市后（status.closed）与美股盘前/盘后（status.preMarket/status.afterHours）原样
 *    返回——此时既不能补 bar（会把非交易日或延长时段当成常规交易时段），也不能并进末根
 *    （那正是要修的缺陷）。
 */
export function withTickerBar(prev: Kline[], ticker: Ticker, context: TickerBarContext): Kline[] {
  const last = prev[prev.length - 1]
  const price = ticker.price
  if (last === undefined || !Number.isFinite(price) || price <= 0) return prev
  if (!Number.isFinite(ticker.timestamp)) return prev
  const timezone = MARKET_TIMEZONE[context.market]
  if (timezone === null || !DAILY_INTERVALS.has(context.interval ?? '')) return mergeIntoLast(prev, price)
  const lastDay = marketLocalDay(timezone, last.openTime)
  const snapshotDay = marketLocalDay(timezone, ticker.timestamp)
  if (lastDay === snapshotDay) return mergeIntoLast(prev, price)
  if (lastDay > snapshotDay) return prev
  if (!tradableAt(context.market, ticker.timestamp)) return prev
  const openTime = dayAnchorMs(snapshotDay)
  const forming: Kline = {
    openTime,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: ticker.volume ?? 0,
    closeTime: openTime + DAY_MS - 1,
  }
  return [...prev, forming]
}

/**
 * K 线全量重取落地时的当日 bar 复原（30s resync 每一拍都整段替换 bar 序列）。
 *
 * 上游缺当日那根时，重取落地等于把 ticker 补出来的当日 bar 抹掉，5s 后 ticker 再补回来
 * ——图上当日蜡烛与以序列为输入的指标末点会跟着 resync 周期闪断。故落地前用最近一次
 * ticker 快照再走一遍 withTickerBar，并让新造的当日 bar 继承上一拍序列的包络
 * （inheritFormingEnvelope）。
 *
 * 门控与回落：
 * - 非日线级别（分钟、五日、周/月线）→ 原样返回，落地行为不变（这几档的当日 bar 不是
 *   本模块造出来的，不该在这里补）。
 * - 没有快照 → 原样返回。
 * - 源不一致（tickerBarMergeable 不通过，即 bar 与快照来自不同源）→ 原样返回，绝不把
 *   一个源的价写进另一个源的序列；两端任一未知时按既有口径视为可合并。
 * - 其余情形走 withTickerBar：同日只并进末根，缺当日那根则补回来（再按 prev 补包络）。
 */
export function restoreFormingBar(rows: Kline[], prev: Kline[], last: TickerSnapshot | null, barSource: string | undefined, context: TickerBarContext): Kline[] {
  if (last === null) return rows
  if (!DAILY_INTERVALS.has(context.interval ?? '')) return rows
  if (!tickerBarMergeable(barSource, last.source)) return rows
  const restored = withTickerBar(rows, last.ticker, context)
  return inheritFormingEnvelope(rows, prev, restored, last, context)
}

/**
 * 复原出来的当日 bar 继承上一拍序列的包络：它是按快照价新造的（open=high=low=close=当拍
 * 价），不继承的话每拍 resync 都把 high/low 塌回那一刻的价格，之后靠后续 tick 再往外推
 * ——图上影线每 30s 收一次再长回来，指标端（KDAS 的 TP=(H+L+C)/3）读数每拍往回跳一次。
 *
 * 继承口径：
 * - 只在**本拍真的补了一根新 bar**（restored 比 rows 多一根）时继承。rows 自己已带当日
 *   那根时，它的开高低收是上游真实数据，不能被合成值覆盖。
 * - prev 的末根必须同属快照的市场本地日：换标的后的第一拍、跨日后的第一拍、prev 末根
 *   还是昨日真 bar 时都不继承——昨日的高低点不得带进今天。
 * - 继承后 open 取 prev 当日的开盘价（当日第一拍的价），high/low 取两边的包络，close 用
 *   当拍快照价，volume 优先用快照量、缺省沿用 prev 当日的量。
 */
function inheritFormingEnvelope(rows: Kline[], prev: Kline[], restored: Kline[], last: TickerSnapshot, context: TickerBarContext): Kline[] {
  if (restored.length !== rows.length + 1) return restored
  const timezone = MARKET_TIMEZONE[context.market]
  if (timezone === null || !Number.isFinite(last.ticker.timestamp)) return restored
  const snapshotDay = marketLocalDay(timezone, last.ticker.timestamp)
  const prevLast = prev[prev.length - 1]
  const restoredLast = restored[restored.length - 1]
  if (prevLast === undefined || restoredLast === undefined) return restored
  if (!Number.isFinite(prevLast.openTime)) return restored
  if (marketLocalDay(timezone, prevLast.openTime) !== snapshotDay) return restored
  if (marketLocalDay(timezone, restoredLast.openTime) !== snapshotDay) return restored
  const inherited: Kline = {
    openTime: restoredLast.openTime,
    open: prevLast.open,
    high: Math.max(prevLast.high, restoredLast.high),
    low: Math.min(prevLast.low, restoredLast.low),
    close: restoredLast.close,
    volume: last.ticker.volume ?? prevLast.volume,
    closeTime: restoredLast.closeTime,
  }
  return [...restored.slice(0, -1), inherited]
}
