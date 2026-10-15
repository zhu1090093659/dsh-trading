/**
 * A 股市场特色短线情绪与资金面数据取数层（同花顺 HiThink 数据赋能）。
 *
 * 覆盖：
 *   - 涨跌停池（首板题材、封单金额、炸板池）
 *   - 集合竞价快照与竞价强弱指标
 *   - 龙虎榜契约类型预留（取数实现规划中）
 *
 * @module @dshtrading/kit-cn/sentiment
 */

import type { AuctionSnapshot, LimitUpPoolItem } from '@dshtrading/api'
import { HiThinkRestClient, normalizeThsCode } from '@dshtrading/connector-hithink'

export interface SentimentOptions {
  apiKey?: string | undefined
  /** 惰性凭证源：`dshtrading.credentials.hithink.apiKey`（设置中心）优先，环境变量兜底；每次取数解析。 */
  apiKeyProvider?: (() => string | undefined) | undefined
  fetchImpl?: typeof globalThis.fetch | undefined
}

/** 凭证解析顺序：显式 apiKey → 惰性 provider（设置中心）→ 环境变量。 */
function resolveApiKey(options: SentimentOptions): string | undefined {
  return options.apiKey ?? options.apiKeyProvider?.() ?? process.env.HITHINK_FINANCE_API_KEY
}

/** 获取当期 A 股涨跌停池与连板股票。 */
export async function fetchCnLimitUpPool(
  queryOptions: { dateMs?: number | undefined; page?: number | undefined; size?: number | undefined } = {},
  sentimentOptions: SentimentOptions = {},
): Promise<LimitUpPoolItem[]> {
  const apiKey = resolveApiKey(sentimentOptions)
  if (!apiKey) {
    throw new Error('HITHINK_FINANCE_API_KEY is not configured. Please set HITHINK_FINANCE_API_KEY in your environment or settings to access limit-up pool data.')
  }
  const client = new HiThinkRestClient({
    apiKey,
    ...(sentimentOptions.fetchImpl !== undefined ? { fetchImpl: sentimentOptions.fetchImpl } : {}),
  })
  return client.getLimitUpPool({
    ...(queryOptions.dateMs !== undefined ? { dateMs: queryOptions.dateMs } : {}),
    ...(queryOptions.page !== undefined ? { page: queryOptions.page } : {}),
    ...(queryOptions.size !== undefined ? { size: queryOptions.size } : {}),
  })
}

/** 获取个股集合竞价快照与强弱基准。 */
export async function fetchCnAuctionStrength(
  symbol: string,
  sentimentOptions: SentimentOptions = {},
): Promise<AuctionSnapshot | undefined> {
  const apiKey = resolveApiKey(sentimentOptions)
  if (!apiKey) {
    return undefined
  }
  const client = new HiThinkRestClient({
    apiKey,
    ...(sentimentOptions.fetchImpl !== undefined ? { fetchImpl: sentimentOptions.fetchImpl } : {}),
  })
  const thscode = normalizeThsCode(symbol)
  return client.getAuctionSnapshot(thscode)
}
