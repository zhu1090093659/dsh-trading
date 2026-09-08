/**
 * 自选迷你走势的日内序列选材（2026-09-08，主流行情软件口径）：
 * - 股票（us/cn/hk）：分钟线按「最后一根 bar 的市场本地日期」筛当日 bar——
 *   非交易日时最后一根 bar 自然落在最近交易日，无需维护节假日历。
 *   粒度按连接器能力自适应：优先 1m，不支持（TRADING_UNSUPPORTED_INTERVAL，
 *   如腾讯 A 股只有 5m/30m）则降 5m；全不支持由调用方降级日 K。
 * - crypto：7×24 无交易日概念，滚动 24h 用 5m K 线（288 根；
 *   1m×1440 超交易所单次取数上限且对 56px 迷你图无视觉增益）。
 */
import type { Kline, MarketId } from './types.ts'

/** 股票市场时区（DST 由 Intl 处理）。crypto 返回 null = 滚动窗口，不做日期分组。 */
const MARKET_TIMEZONE: Record<MarketId, string | null> = {
  crypto: null,
  us: 'America/New_York',
  cn: 'Asia/Shanghai',
  hk: 'Asia/Hong_Kong',
}

export type IntradayInterval = '1m' | '5m'

export interface IntradayRequest {
  interval: IntradayInterval
  limit: number
}

/** 分钟线候选粒度（按序尝试，首个成功粒度被调用方记住）。crypto 固定 5m。 */
export function intradayCandidates(market: MarketId): readonly IntradayInterval[] {
  return market === 'crypto' ? ['5m'] : ['1m', '5m']
}

/** 取数上限：1m 覆盖美股常规时段 390 根 + 盘前尾盘余量；5m 约两个交易日。 */
export function intradayRequest(market: MarketId, interval: IntradayInterval): IntradayRequest {
  if (market === 'crypto') return { interval: '5m', limit: 288 }
  return { interval, limit: interval === '1m' ? 500 : 200 }
}

/**
 * K 线 → 迷你走势收盘价序列。
 * crypto：入序列原样取 close（调用方已按 24h 窗口截尾）。
 * 股票：只保留最后一根 bar 所在市场本地交易日的 bar。
 */
export function selectIntradayCloses(market: MarketId, klines: readonly Kline[]): number[] {
  if (klines.length === 0) return []
  const tz = MARKET_TIMEZONE[market]
  if (tz === null) return klines.map(k => k.close)
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const lastBar = klines[klines.length - 1] as Kline
  const lastDay = fmt.format(lastBar.openTime)
  return klines.filter(k => fmt.format(k.openTime) === lastDay).map(k => k.close)
}

/* ------------------------------------------------------------------ */
/* 固定交易时段 x 轴（2026-09-08）：盘中未走完的交易日，迷你走势只应    */
/* 铺满左侧已完成部分，而不是把已有数据拉伸到全宽（否则上午 11 点的      */
/* 分时看起来像已收盘）。crypto 滚动 24h 窗口天然固定，无需 x 映射。   */
/* ------------------------------------------------------------------ */

/** 各市场常规时段（市场本地分钟数 since 00:00；午休等休止段压缩掉）。 */
const SESSION_SPANS: Record<Exclude<MarketId, 'crypto'>, { spans: readonly (readonly [number, number])[]; total: number }> = {
  us: { spans: [[570, 960]], total: 390 },            // 9:30–16:00 ET
  cn: { spans: [[570, 690], [780, 900]], total: 240 }, // 9:30–11:30 + 13:00–15:00 CST
  hk: { spans: [[570, 720], [780, 960]], total: 330 }, // 9:30–12:00 + 13:00–16:00 HKT
}

const timeFmtCache = new Map<string, Intl.DateTimeFormat>()

function localMinutes(tz: string, openTime: number): number {
  let fmt = timeFmtCache.get(tz)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    timeFmtCache.set(tz, fmt)
  }
  const parts = fmt.formatToParts(openTime)
  const hour = Number(parts.find(p => p.type === 'hour')?.value)
  const minute = Number(parts.find(p => p.type === 'minute')?.value)
  return hour * 60 + minute
}

/**
 * bar 开盘时刻 → 当日交易时段内的 x 位置（0..1）。时段外（盘前/盘后/午休）
 * 钳制到最近边界：盘前→0，午休→上午收盘位置，盘后→1。
 */
export function sessionXFraction(market: MarketId, openTime: number): number | null {
  const tz = MARKET_TIMEZONE[market]
  if (tz === null) return null
  const session = SESSION_SPANS[market as Exclude<MarketId, 'crypto'>]
  const t = localMinutes(tz, openTime)
  let acc = 0
  for (const [start, end] of session.spans) {
    if (t <= start) return acc / session.total
    if (t < end) return (acc + (t - start)) / session.total
    acc += end - start
  }
  return 1
}

/**
 * 与 selectIntradayCloses 同筛选口径，返回 closes + 每点的固定时段 x 位置。
 * crypto 不返回 xFractions（滚动窗口等距即可）。
 */
export function selectIntradaySeries(market: MarketId, klines: readonly Kline[]): { closes: number[]; xFractions?: number[] } {
  if (klines.length === 0) return { closes: [] }
  const tz = MARKET_TIMEZONE[market]
  if (tz === null) return { closes: klines.map(k => k.close) }
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const lastBar = klines[klines.length - 1] as Kline
  const lastDay = fmt.format(lastBar.openTime)
  const dayBars = klines.filter(k => fmt.format(k.openTime) === lastDay)
  return {
    closes: dayBars.map(k => k.close),
    xFractions: dayBars.map(k => sessionXFraction(market, k.openTime) ?? 0),
  }
}
