/**
 * @dshtrading/connector-hithink
 * 同花顺官方金融数据服务 API 契约与内部数据类型。
 */

export interface HiThinkEnvelope<T> {
  code: number
  message: string
  request_id?: string
  data?: T
}

export interface HiThinkPriceSnapshotItem {
  thscode: string
  ticker: string
  last_price?: number
  price_change?: number
  price_change_ratio_pct?: number
  open_price?: number
  high_price?: number
  low_price?: number
  prev_price?: number
  volume?: number
  turnover?: number
}

export interface HiThinkPriceSnapshotData {
  timestamp: number | null
  total: number
  item: HiThinkPriceSnapshotItem[]
}

export interface HiThinkValuationItem {
  thscode: string
  ticker: string
  pe_ttm?: number | null
  pe_mrq?: number | null
  pb_mrq?: number | null
  ps_ttm?: number | null
  pcf_ttm?: number | null
}

export interface HiThinkValuationData {
  timestamp: number | null
  total: number
  item: HiThinkValuationItem[]
}

export interface HiThinkLimitUpItem {
  thscode: string
  ticker: string
  name: string
  is_st?: boolean
  is_new?: boolean
  last_price: number
  price_change_ratio_pct: number
  limit_up_time?: string
  limit_up_reason?: string
  continue_day_text?: string
  continue_day_cnt?: number
  seal_money?: number
  max_seal_money?: number
}

export interface HiThinkLimitUpPoolData {
  timestamp: number
  pagination?: {
    total: number
    pages: number
    size: number
    page: number
  }
  item: HiThinkLimitUpItem[]
}

export interface HiThinkLadderBoardItem {
  thscode: string
  ticker: string
  name: string
  board_num: number
  sign_level?: string
  seal_nextday?: string | null
}

export interface HiThinkLadderDayItem {
  date: string
  boards: {
    two_board?: HiThinkLadderBoardItem[]
    three_board?: HiThinkLadderBoardItem[]
    four_board?: HiThinkLadderBoardItem[]
    five_board?: HiThinkLadderBoardItem[]
    six_board?: HiThinkLadderBoardItem[]
    seven_over?: HiThinkLadderBoardItem[]
  }
}

export interface HiThinkLadderData {
  timestamp: number
  window?: {
    length: number
    date_list: string[]
    board_caps: Record<string, number>
  }
  item: HiThinkLadderDayItem[]
}

export interface HiThinkAuctionItem {
  thscode: string
  ticker: string
  match_price?: number
  match_volume?: number
  unmatched_volume?: number
  unmatched_side?: 'buy' | 'sell' | string
  strength_index?: number
  stage?: 'call' | 'final' | string
}

export interface HiThinkAuctionData {
  timestamp: number | null
  item: HiThinkAuctionItem[]
}

export interface HiThinkTickerSearchItem {
  thscode: string
  ticker: string
  name: string
  asset_type?: string
  exchange?: string
}

export interface HiThinkTickerSearchData {
  total: number
  item: HiThinkTickerSearchItem[]
}

/* ── K 线与元信息域（历史日K / 期货 / 代码表） ─────────────────────────── */

/** A 股历史日K条目（/api/a-share/prices/historical，date_ms 为东八区交易日零点）。 */
export interface HiThinkPriceBarItem {
  date_ms?: number | null
  open_price?: number | null
  high_price?: number | null
  low_price?: number | null
  close_price?: number | null
  volume?: number | null
  turnover?: number | null
}

export interface HiThinkHistoricalData {
  timestamp: number | null
  item: HiThinkPriceBarItem[]
}

/** 期货日K条目（/api/futures/prices/daily，timestamp 为毫秒；与 A 股的 date_ms 字段名不同）。 */
export interface HiThinkFuturesDailyItem {
  timestamp?: number | null
  open_price?: number | null
  high_price?: number | null
  low_price?: number | null
  close_price?: number | null
  volume?: number | null
  turnover?: number | null
}

export interface HiThinkFuturesDailyData {
  timestamp: number | null
  thscode: string
  interval: string
  item: HiThinkFuturesDailyItem[]
}

/** 期货当日分时点（/api/futures/prices/intraday；价格点序列，非 OHLC）。 */
export interface HiThinkFuturesIntradayItem {
  timestamp?: number | null
  price?: number | null
  volume?: number | null
  turnover?: number | null
}

export interface HiThinkFuturesIntradayData {
  timestamp: number | null
  thscode: string
  date: string
  session: string
  item: HiThinkFuturesIntradayItem[]
}

/** 跨资产代码表条目（/api/meta/tickers/list|search，日期为 yyyy-MM-dd 或 null）。 */
export interface HiThinkMetaTickerItem {
  thscode: string
  ticker: string
  name: string
  exchange?: string | null
  asset_type: string
  currency?: string | null
  list_date?: string | null
  end_date?: string | null
  last_trade_date?: string | null
  last_delivery_date?: string | null
}

export interface HiThinkMetaTickerData {
  timestamp: number | null
  item: HiThinkMetaTickerItem[]
}
