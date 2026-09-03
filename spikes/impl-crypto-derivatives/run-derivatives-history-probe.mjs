/**
 * issue #54 spike 探针：用已构建的连接器 REST 客户端（lib 产物）直连真实端点，
 * 验证衍生品扩展字段（nextFundingRate/nextFundingTime/markPrice/indexPrice）与
 * 历史序列（funding history / OI history）的真实响应解析。
 * 用法：node run-derivatives-history-probe.mjs > ../parsed-history-probe.json
 */
import { OkxRestClient, toOkxSwapInstId } from '../../packages/connector-okx/lib/rest.js'
import { BinanceRestClient } from '../../packages/connector-binance/lib/rest.js'
import { BybitRestClient } from '../../packages/connector-bybit/lib/rest.js'

const SYMBOL = 'HYPEUSDT'
const out = { fetchedAt: new Date().toISOString(), symbol: SYMBOL, results: {} }

async function probe(label, task) {
  try {
    const value = await task()
    out.results[label] = { ok: true, value }
  } catch (error) {
    out.results[label] = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const okx = new OkxRestClient({ clockSync: false })
const swapId = toOkxSwapInstId(SYMBOL)
await probe('okx.fundingRate(含next)', () => okx.getFundingRate(swapId))
await probe('okx.markPrice', () => okx.getMarkPrice(swapId))
await probe('okx.indexPrice', () => okx.getIndexPrice(swapId.replace(/-SWAP$/, '')))
await probe('okx.fundingRateHistory(30)', async () => (await okx.getFundingRateHistory(swapId, 30)).slice(-3))
await probe('okx.openInterestHistory(30)', async () => (await okx.getOpenInterestHistory(swapId, 30)).slice(-3))

const binance = new BinanceRestClient()
await probe('binance.premiumIndex', () => binance.getFuturesPremiumIndex(SYMBOL))
await probe('binance.fundingRateHistory(30)', async () => (await binance.getFuturesFundingRateHistory(SYMBOL, 30)).slice(-3))
await probe('binance.openInterestHistory(30d)', async () => (await binance.getFuturesOpenInterestHistory(SYMBOL, 30)).slice(-3))

const bybit = new BybitRestClient()
await probe('bybit.linearTicker(扩展字段)', () => bybit.getLinearTickerSnapshot(SYMBOL))
await probe('bybit.fundingHistory(30)', async () => (await bybit.getLinearFundingHistory(SYMBOL, 30)).slice(-3))
await probe('bybit.openInterestHistory(30d)', async () => (await bybit.getLinearOpenInterestHistory(SYMBOL, 30)).slice(-3))

console.log(JSON.stringify(out, null, 2))
