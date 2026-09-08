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
