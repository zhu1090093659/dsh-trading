/**
 * @dshtrading/connector-hithink
 * 同花顺期货市场数据服务（/api/futures/* + /api/meta/tickers/*）。
 *
 * 上游能力边界：日K（最近 100 根或 start/end 窗口）+ 当日分时点（pre/intraday/post）；
 * 无实时快照端点，getTicker 由「分时末点 + 日K」派生；分钟线仅当日。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Disposable, Interval, Kline, MarketDataService, Ticker } from '@dshtrading/api'
import { HiThinkRestClient, type HiThinkRestOptions } from './rest.js'
import { aggregateDailyKlines, aggregateMinutePoints, dailyBarToKline } from './kline.js'

export const TRADING_FUTURES_MARKET_DATA_KEY = 'tradingFuturesMarketData'

/** 期货分钟周期 → 分时点聚合步长（分钟）。上游仅提供当日分时，分钟线仅覆盖当日。 */
const MINUTE_INTERVAL_STEPS: Partial<Record<Interval, number>> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '8h': 480,
  '12h': 720,
}

/** 规范化期货代码输入（大写、去空白；带/不带交易所后缀均透传，后缀歧义交由上游裁决）。 */
export function normalizeFuturesCode(input: string): string {
  return input.trim().toUpperCase()
}

export class HiThinkFuturesMarketDataService extends Service implements MarketDataService {
  private readonly client: HiThinkRestClient

  constructor(
    ctx: Context,
    options: HiThinkRestOptions = {},
    serviceName: string = TRADING_FUTURES_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new HiThinkRestClient(options)
  }

  /** 最新价：分时末点优先（盘中即时），失败/为空回落日K最近根（收盘价）。 */
  async getTicker(symbol: string): Promise<Ticker> {
    const thscode = normalizeFuturesCode(symbol)
    const dailyBars = await this.client.getFuturesDailyKlines(thscode, 2)
    const lastDaily = dailyBars[dailyBars.length - 1]
    const prevDaily = dailyBars.length >= 2 ? dailyBars[dailyBars.length - 2] : undefined

    let price = lastDaily?.close_price ?? 0
    let timestamp = lastDaily?.timestamp ?? Date.now()
    try {
      const intraday = await this.client.getFuturesIntraday(thscode)
      const points = (intraday?.item ?? []).filter(
        (p): p is { timestamp: number; price: number; volume?: number | null; turnover?: number | null } =>
          typeof p.timestamp === 'number' && typeof p.price === 'number',
      )
      const last = points[points.length - 1]
      if (last) {
        price = last.price
        timestamp = last.timestamp
      }
    } catch {
      // 分时不可得（非交易时段/上游异常）时静默回落日K收盘价
    }

    return {
      symbol: thscode,
      price,
      ...(prevDaily?.close_price !== undefined && prevDaily?.close_price !== null ? { prevClose: prevDaily.close_price } : {}),
      ...(lastDaily?.volume !== undefined && lastDaily?.volume !== null ? { volume: lastDaily.volume } : {}),
      timestamp,
    }
  }

  /**
   * 期货 K 线：1d 直连日K；3d/1w/1M 由日K本地聚合；分钟周期由当日分时点聚合
   * （上游仅提供当日分时，分钟线不覆盖历史交易日）。
   */
  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const thscode = normalizeFuturesCode(symbol)
    const n = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 100, 1000))

    const minuteStep = MINUTE_INTERVAL_STEPS[interval]
    if (minuteStep !== undefined) {
      const intraday = await this.client.getFuturesIntraday(thscode)
      const points = (intraday?.item ?? []).flatMap((p) =>
        typeof p.timestamp === 'number' && typeof p.price === 'number'
          ? [{ timestamp: p.timestamp, price: p.price, volume: p.volume ?? 0 }]
          : [],
      )
      return aggregateMinutePoints(points, minuteStep).slice(-n)
    }

    const dailyBars = await this.client.getFuturesDailyKlines(thscode, interval === '1d' ? n : Math.min(n * 35, 1000))
    const daily = dailyBars.map((b) => dailyBarToKline(
      b.timestamp as number,
      b.open_price as number,
      b.high_price as number,
      b.low_price as number,
      b.close_price as number,
      b.volume ?? 0,
    ))
    if (interval === '1d') return daily
    return aggregateDailyKlines(daily, interval as '3d' | '1w' | '1M').slice(-n)
  }

  /**
   * 期货标的名册/检索（GUI 添加自选对话框）。带 query 走跨资产检索（asset_type=futures），
   * 无 query 返回全量代码表（过滤 last_trade_date 已过期的合约）。
   */
  async listInstruments(query?: string): Promise<Array<{ symbol: string; name: string }>> {
    const trimmed = query?.trim()
    if (trimmed) {
      const items = await this.client.searchFuturesTickers(trimmed)
      return items.map((item) => ({ symbol: item.thscode, name: item.name }))
    }
    const items = await this.client.listFuturesTickers()
    const todayKey = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
    return items
      .filter((item) => item.last_trade_date === null || item.last_trade_date === undefined || item.last_trade_date >= todayKey)
      .map((item) => ({ symbol: item.thscode, name: item.name }))
  }

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: { intervalMs?: number }): Disposable {
    const ms = Math.max(options?.intervalMs ?? 10_000, 3_000)
    const tick = (): void => {
      void this.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}
