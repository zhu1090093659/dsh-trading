/**
 * A 股市场特色短线情绪与资金面数据取数层（同花顺 HiThink 数据赋能）。
 *
 * 覆盖：
 *   - 涨跌停池与连板天梯（连板高度、首板题材、封单金额、炸板池）
 *   - 集合竞价快照与竞价强弱指标
 *   - 龙虎榜营业部与机构席位
 *
 * @module @dsh-trading/kit-cn/sentiment
 */

import type { AuctionSnapshot, LimitUpPoolItem } from '@dsh-trading/api'
import { HiThinkRestClient, normalizeThsCode } from '@dsh-trading/connector-hithink'

export interface SentimentOptions {
  apiKey?: string | undefined
  fetchImpl?: typeof globalThis.fetch | undefined
}

/** 获取当期 A 股涨跌停池与连板股票。 */
export async function fetchCnLimitUpPool(
  queryOptions: { dateMs?: number | undefined; page?: number | undefined; size?: number | undefined } = {},
  sentimentOptions: SentimentOptions = {},
): Promise<LimitUpPoolItem[]> {
  const apiKey = sentimentOptions.apiKey ?? process.env.HITHINK_FINANCE_API_KEY
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

/** 获取近 30 个交易日连板天梯矩阵。 */
export async function fetchCnLimitUpLadder(sentimentOptions: SentimentOptions = {}) {
  const apiKey = sentimentOptions.apiKey ?? process.env.HITHINK_FINANCE_API_KEY
  if (!apiKey) {
    throw new Error('HITHINK_FINANCE_API_KEY is not configured. Please set HITHINK_FINANCE_API_KEY to access limit-up ladder data.')
  }
  const client = new HiThinkRestClient({
    apiKey,
    ...(sentimentOptions.fetchImpl !== undefined ? { fetchImpl: sentimentOptions.fetchImpl } : {}),
  })
  return client.getLimitUpLadder()
}

/** 获取个股集合竞价快照与强弱基准。 */
export async function fetchCnAuctionStrength(
  symbol: string,
  sentimentOptions: SentimentOptions = {},
): Promise<AuctionSnapshot | undefined> {
  const apiKey = sentimentOptions.apiKey ?? process.env.HITHINK_FINANCE_API_KEY
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
