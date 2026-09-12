/**
 * @dshtrading/connector-hithink
 * 同花顺官方金融数据服务 REST 客户端实现。
 *
 * 协议基线：
 *   - Base URL: https://fuyao.aicubes.cn
 *   - 认证: Header X-api-key: <HITHINK_FINANCE_API_KEY>
 *   - 响应信封: { code: 0, message: 'success', data: ... }
 *   - 标的规范: 完整 thscode（如 600519.SH, 000001.SZ, 300750.SZ, 688981.SH）
 *
 * @module @dshtrading/connector-hithink/rest
 */

import type {
  AuctionSnapshot,
  LimitUpPoolItem,
  StockFundamentals,
  Ticker,
  TradingErrorCode,
} from '@dshtrading/api'
import type {
  HiThinkAuctionData,
  HiThinkEnvelope,
  HiThinkFuturesDailyData,
  HiThinkFuturesIntradayData,
  HiThinkHistoricalData,
  HiThinkLadderData,
  HiThinkLimitUpPoolData,
  HiThinkMetaTickerData,
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
  apiKey?: string | undefined
  /** 惰性凭证源（每次请求解析）：settings credentials 热切换与异步加载晚于插件 apply 时生效。 */
  apiKeyProvider?: (() => string | undefined) | undefined
  baseUrl?: string | undefined
  fetchImpl?: typeof fetch | undefined
  timeoutMs?: number | undefined
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
    const suffix = code.startsWith('920') || code.startsWith('8') || code.startsWith('4')
      ? 'BJ'
      : code.startsWith('6') || code.startsWith('900')
        ? 'SH'
        : 'SZ'
    return `${code}.${suffix}`
  }
  return raw
}

export class HiThinkRestClient {
  private readonly apiKey?: string | undefined
  private readonly apiKeyProvider?: (() => string | undefined) | undefined
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: HiThinkRestOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.HITHINK_FINANCE_API_KEY ?? process.env.HITHINK_API_KEY
    this.apiKeyProvider = options.apiKeyProvider
    this.baseUrl = (options.baseUrl ?? 'https://fuyao.aicubes.cn').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  private resolvedApiKey(): string | undefined {
    return this.apiKeyProvider?.() ?? this.apiKey
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
    const apiKey = this.resolvedApiKey()
    if (apiKey) {
      headers['X-api-key'] = apiKey
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
        'TRADING_NETWORK',
        `HiThink request failed (${url.pathname}): ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new TradingServiceError('TRADING_AUTH_FAILED', `HiThink authentication failed (HTTP ${res.status}). Check HITHINK_FINANCE_API_KEY.`)
      }
      if (res.status === 429) {
        throw new TradingServiceError('TRADING_RATE_LIMITED', `HiThink rate limited (HTTP 429). Retry later.`)
      }
      throw new TradingServiceError('TRADING_NETWORK', `HiThink upstream error (HTTP ${res.status})`)
    }

    const json = (await res.json()) as HiThinkEnvelope<T>
    if (json.code !== 0) {
      if (json.code === 2001 || json.code === 2003) {
        throw new TradingServiceError('TRADING_AUTH_FAILED', `HiThink auth error (${json.code}): ${json.message}`)
      }
      if (json.code === 4001) {
        throw new TradingServiceError('TRADING_RATE_LIMITED', `HiThink rate limited (${json.code}): ${json.message}`)
      }
      if (json.code === 3001) {
        throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `HiThink ticker not found (${json.code}): ${json.message}`)
      }
      throw new TradingServiceError('TRADING_UNKNOWN', `HiThink API error (${json.code}): ${json.message}`)
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
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `HiThink: no quote found for ${symbol} (${thscode})`)
    }

    const price = item.last_price ?? item.prev_price ?? 0
    return {
      symbol: thscode,
      price,
      ...(item.prev_price !== undefined ? { prevClose: item.prev_price } : {}),
      ...(item.price_change_ratio_pct !== undefined ? { changePercent: item.price_change_ratio_pct } : {}),
      ...(item.volume !== undefined ? { volume: item.volume } : {}),
      timestamp: data?.timestamp ?? Date.now(),
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
      ...(typeof valItem?.pe_ttm === 'number' ? { peTtm: valItem.pe_ttm } : {}),
      ...(typeof valItem?.pe_mrq === 'number' ? { peDynamic: valItem.pe_mrq } : {}),
      ...(typeof valItem?.pb_mrq === 'number' ? { pb: valItem.pb_mrq } : {}),
      ...(typeof valItem?.ps_ttm === 'number' ? { ps: valItem.ps_ttm } : {}),
      timestamp: tickerVal?.timestamp ?? Date.now(),
    }
  }

  /** 获取今日或指定日期涨跌停池。 */
  async getLimitUpPool(options: { dateMs?: number; page?: number; size?: number } = {}): Promise<LimitUpPoolItem[]> {
    const data = await this.request<HiThinkLimitUpPoolData>('/api/a-share/special-data/limit-up-pool', {
      ...(options.dateMs !== undefined ? { date_ms: options.dateMs } : {}),
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
      limitType: 'up' as const,
      ...(item.limit_up_time !== undefined ? { firstLimitTime: item.limit_up_time } : {}),
      ...(item.seal_money !== undefined ? { limitOrderAmount: item.seal_money } : {}),
      ...(item.continue_day_cnt !== undefined ? { consecutiveBoards: item.continue_day_cnt } : {}),
      ...(item.limit_up_reason !== undefined ? { sectorConcept: item.limit_up_reason } : {}),
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

    const unmatchedSide = item.unmatched_side === 'buy' || item.unmatched_side === 'sell'
      ? item.unmatched_side
      : undefined
    const stage = item.stage === 'call' || item.stage === 'final'
      ? item.stage
      : undefined

    return {
      symbol: thscode,
      ...(item.match_price !== undefined ? { matchPrice: item.match_price } : {}),
      ...(item.match_volume !== undefined ? { matchVolume: item.match_volume } : {}),
      ...(item.unmatched_volume !== undefined ? { unmatchedVolume: item.unmatched_volume } : {}),
      ...(unmatchedSide !== undefined ? { unmatchedSide } : {}),
      ...(item.strength_index !== undefined ? { strengthIndex: item.strength_index } : {}),
      ...(stage !== undefined ? { stage } : {}),
      timestamp: data?.timestamp ?? Date.now(),
    }
  }

  /** 模糊搜索股票代码与全称（消歧）。 */
  async searchTickers(keyword: string): Promise<Array<{ symbol: string; name: string }>> {
    const data = await this.request<HiThinkTickerSearchData>('/api/a-share/instruments/search', {
      keyword: keyword.trim(),
    })
    const list = data?.item ?? []
    return list.map((item) => ({
      symbol: item.thscode,
      name: item.name,
    }))
  }

  /* ── K 线与元信息域 ──────────────────────────────────────────────── */

  /**
   * A 股历史日K（上游仅开放 1d，start/end 毫秒必填，窗口最长 10 年）。
   * 以 end=now 反推覆盖窗口取数后截尾最近 limit 根（升序）。
   */
  async getHistoricalDailyKlines(symbol: string, limit: number, adjust: 'none' | 'forward' | 'backward' = 'forward'): Promise<HiThinkHistoricalData['item']> {
    const thscode = normalizeThsCode(symbol)
    const end = Date.now()
    const windowDays = Math.min(Math.ceil(limit * 1.7) + 7, 3650)
    const data = await this.request<HiThinkHistoricalData>('/api/a-share/prices/historical', {
      thscode,
      interval: '1d',
      start: end - windowDays * 86_400_000,
      end,
      adjust,
    })
    const bars = (data?.item ?? []).filter((b) => typeof b.date_ms === 'number' && typeof b.close_price === 'number')
    return bars.slice(-limit)
  }

  /** 期货日K（省略 start/end 返回最近 100 根；窗口模式可取更长序列）。 */
  async getFuturesDailyKlines(thscode: string, limit: number): Promise<HiThinkFuturesDailyData['item']> {
    const end = Date.now()
    const windowDays = Math.min(Math.ceil(limit * 1.7) + 7, 3650)
    const data = await this.request<HiThinkFuturesDailyData>('/api/futures/prices/daily', {
      thscode,
      ...(limit > 100 ? { start: end - windowDays * 86_400_000, end } : {}),
    })
    const bars = (data?.item ?? []).filter((b) => typeof b.timestamp === 'number' && typeof b.close_price === 'number')
    return bars.slice(-limit)
  }

  /** 期货当日分时点（session 缺省 intraday；非交易时段可能为空）。 */
  async getFuturesIntraday(thscode: string, session?: 'pre_market' | 'intraday' | 'post_market'): Promise<HiThinkFuturesIntradayData> {
    return this.request<HiThinkFuturesIntradayData>('/api/futures/prices/intraday', {
      thscode,
      ...(session !== undefined ? { session } : {}),
    })
  }

  /** 跨资产标的检索（期货用 asset_type=futures 过滤；q 支持 thscode/代码/中英文名称子串）。 */
  async searchFuturesTickers(keyword: string, limit = 50): Promise<HiThinkMetaTickerData['item']> {
    const data = await this.request<HiThinkMetaTickerData>('/api/meta/tickers/search', {
      q: keyword.trim(),
      asset_type: 'futures',
      limit,
    })
    return data?.item ?? []
  }

  /** 期货全量代码表（offset 分页取尽；由调用方过滤已到期合约）。 */
  async listFuturesTickers(): Promise<HiThinkMetaTickerData['item']> {
    const all: HiThinkMetaTickerData['item'] = []
    const pageSize = 10_000
    for (let offset = 0; offset < 100_000; offset += pageSize) {
      const data = await this.request<HiThinkMetaTickerData>('/api/meta/tickers/list', {
        asset_type: 'futures',
        limit: pageSize,
        offset,
      })
      const page = data?.item ?? []
      all.push(...page)
      if (page.length < pageSize) break
    }
    return all
  }
}
