/**
 * @dsh-trading/connector-hithink
 * 同花顺官方金融数据服务 REST 客户端实现。
 *
 * 协议基线：
 *   - Base URL: https://fuyao.aicubes.cn
 *   - 认证: Header X-api-key: <HITHINK_FINANCE_API_KEY>
 *   - 响应信封: { code: 0, message: 'success', data: ... }
 *   - 标的规范: 完整 thscode（如 600519.SH, 000001.SZ, 300750.SZ, 688981.SH）
 *
 * @module @dsh-trading/connector-hithink/rest
 */

import type {
  AuctionSnapshot,
  Interval,
  Kline,
  LimitUpPoolItem,
  StockFundamentals,
  Ticker,
  TradingErrorCode,
} from '@dsh-trading/api'
import type {
  HiThinkAuctionData,
  HiThinkEnvelope,
  HiThinkLadderData,
  HiThinkLimitUpPoolData,
  HiThinkPriceSnapshotData,
  HiThinkTickerSearchData,
  HiThinkValuationData,
} from './types.js'

export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

export interface HiThinkRestOptions {
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** 规范化输入为标准 thscode（如 600519 -> 600519.SH, sz000001 -> 000001.SZ）。 */
export function normalizeThsCode(input: string): string {
  const raw = input.trim().toUpperCase()
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(raw)) {
    return raw
  }
  const prefixMatch = /^(SH|SZ|BJ)(\d{6})$/.exec(raw)
  if (prefixMatch && prefixMatch[1] && prefixMatch[2]) {
    return `${prefixMatch[2]}.${prefixMatch[1]}`
  }
  const codeMatch = /^(\d{6})$/.exec(raw)
  if (codeMatch && codeMatch[1]) {
    const code = codeMatch[1]
    const suffix = code.startsWith('6') || code.startsWith('9') || code.startsWith('688')
      ? 'SH'
      : code.startsWith('8') || code.startsWith('4') || code.startsWith('920')
        ? 'BJ'
        : 'SZ'
    return `${code}.${suffix}`
  }
  return raw
}

export class HiThinkRestClient {
  private readonly apiKey?: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: HiThinkRestOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.HITHINK_FINANCE_API_KEY
    this.baseUrl = (options.baseUrl ?? 'https://fuyao.aicubes.cn').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  private async request<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) {
        url.searchParams.set(k, String(v))
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'dsh-trading/0.1.0',
    }
    if (this.apiKey) {
      headers['X-api-key'] = this.apiKey
    }

    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      throw new TradingServiceError(
        'NETWORK_TIMEOUT',
        `HiThink request failed (${url.pathname}): ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new TradingServiceError('AUTH_FAILED', `HiThink authentication failed (HTTP ${res.status}). Check HITHINK_FINANCE_API_KEY.`)
      }
      if (res.status === 429) {
        throw new TradingServiceError('RATE_LIMITED', `HiThink rate limited (HTTP 429). Retry later.`)
      }
      throw new TradingServiceError('NETWORK_ERROR', `HiThink upstream error (HTTP ${res.status})`)
    }

    const json = (await res.json()) as HiThinkEnvelope<T>
    if (json.code !== 0) {
      if (json.code === 2001 || json.code === 2003) {
        throw new TradingServiceError('AUTH_FAILED', `HiThink auth error (${json.code}): ${json.message}`)
      }
      if (json.code === 4001) {
        throw new TradingServiceError('RATE_LIMITED', `HiThink rate limited (${json.code}): ${json.message}`)
      }
      if (json.code === 3001) {
        throw new TradingServiceError('INSTRUMENT_NOT_FOUND', `HiThink ticker not found (${json.code}): ${json.message}`)
      }
      throw new TradingServiceError('UNKNOWN_ERROR', `HiThink API error (${json.code}): ${json.message}`)
    }

    return json.data as T
  }

  /** 获取最新行情快照。 */
  async getTicker(symbol: string): Promise<Ticker> {
    const thscode = normalizeThsCode(symbol)
    const data = await this.request<HiThinkPriceSnapshotData>('/api/a-share/prices/snapshot', {
      thscodes: thscode,
    })

    const item = data?.item?.[0]
    if (!item) {
      throw new TradingServiceError('INSTRUMENT_NOT_FOUND', `HiThink: no quote found for ${symbol} (${thscode})`)
    }

    const price = item.last_price ?? item.prev_price ?? 0
    return {
      symbol: thscode,
      price,
      prevClose: item.prev_price,
      changePercent: item.price_change_ratio_pct,
      volume: item.volume,
      timestamp: data.timestamp ?? Date.now(),
    }
  }

  /** 获取标的估值快照。 */
  async getValuation(symbol: string): Promise<HiThinkValuationData['item'][0] | undefined> {
    const thscode = normalizeThsCode(symbol)
    const data = await this.request<HiThinkValuationData>('/api/a-share/valuations/snapshot', {
      thscodes: thscode,
    })
    return data?.item?.[0]
  }

  /** 获取综合估值指标快照（StockFundamentals 适配）。 */
  async getStockFundamentals(symbol: string): Promise<StockFundamentals> {
    const thscode = normalizeThsCode(symbol)
    const [ticker, val] = await Promise.allSettled([
      this.getTicker(thscode),
      this.getValuation(thscode),
    ])

    const tickerVal = ticker.status === 'fulfilled' ? ticker.value : undefined
    const valItem = val.status === 'fulfilled' ? val.value : undefined

    return {
      symbol: thscode,
      peTtm: valItem?.pe_ttm ?? undefined,
      peDynamic: valItem?.pe_mrq ?? undefined,
      pb: valItem?.pb_mrq ?? undefined,
      ps: valItem?.ps_ttm ?? undefined,
      timestamp: tickerVal?.timestamp ?? Date.now(),
    }
  }

  /** 获取今日或指定日期涨跌停池。 */
  async getLimitUpPool(options: { dateMs?: number; page?: number; size?: number } = {}): Promise<LimitUpPoolItem[]> {
    const data = await this.request<HiThinkLimitUpPoolData>('/api/a-share/special-data/limit-up-pool', {
      date_ms: options.dateMs,
      page: options.page ?? 1,
      size: options.size ?? 50,
      sort_field: 'limit_up_time',
      sort_dir: 'asc',
    })

    const items = data?.item ?? []
    return items.map((item) => ({
      symbol: item.thscode,
      name: item.name,
      price: item.last_price,
      changePercent: item.price_change_ratio_pct,
      limitType: 'up',
      firstLimitTime: item.limit_up_time,
      limitOrderAmount: item.seal_money,
      consecutiveBoards: item.continue_day_cnt,
      sectorConcept: item.limit_up_reason,
    }))
  }

  /** 获取连板天梯数据。 */
  async getLimitUpLadder(): Promise<HiThinkLadderData> {
    return this.request<HiThinkLadderData>('/api/a-share/special-data/limit-up-ladder')
  }

  /** 获取集合竞价快照与强弱基准。 */
  async getAuctionSnapshot(symbol: string): Promise<AuctionSnapshot | undefined> {
    const thscode = normalizeThsCode(symbol)
    const data = await this.request<HiThinkAuctionData>('/api/a-share/auction/snapshot', {
      thscodes: thscode,
    })
    const item = data?.item?.[0]
    if (!item) return undefined

    return {
      symbol: thscode,
      matchPrice: item.match_price,
      matchVolume: item.match_volume,
      unmatchedVolume: item.unmatched_volume,
      unmatchedSide: item.unmatched_side === 'buy' || item.unmatched_side === 'sell' ? item.unmatched_side : undefined,
      strengthIndex: item.strength_index,
      stage: item.stage === 'call' || item.stage === 'final' ? item.stage : undefined,
      timestamp: data.timestamp ?? Date.now(),
    }
  }

  /** 标的代码与名称搜索消歧。 */
  async searchTickers(query: string): Promise<HiThinkTickerSearchData['item']> {
    const data = await this.request<HiThinkTickerSearchData>('/api/meta/tickers/search', {
      q: query,
      limit: 10,
    })
    return data?.item ?? []
  }

  /** 获取 K 线数据（日线保底适配）。 */
  async getKlines(symbol: string, _interval: Interval = '1d', _limit: number = 100): Promise<Kline[]> {
    // HiThink 公开版重点在于行情快照与全市场 dump，日 K 线由快照兜底
    const ticker = await this.getTicker(symbol)
    return [
      {
        openTime: ticker.timestamp,
        open: ticker.prevClose ?? ticker.price,
        high: ticker.price,
        low: ticker.price,
        close: ticker.price,
        volume: ticker.volume ?? 0,
        closeTime: ticker.timestamp,
      },
    ]
  }
}
