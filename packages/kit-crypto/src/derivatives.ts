/**
 * crypto_get_derivatives 的快照读取面（WS4 衍生品数据面；P6 改为 registry-first）。
 *
 * 数据源（registry-first）：
 *   - 常态：路由选中的 crypto 行情服务的 getDerivatives——与 crypto_get_derivatives_history
 *     同源；provider 未实现该能力时抛 TRADING_NOT_IMPLEMENTED，绝不回退 Binance 冒充路由源；
 *   - 回退：注册表服务缺席（老部署 / 无 router）时保留历史行为——直连 Binance USDT-M
 *     公共无 key 端点（openInterest / globalLongShortAccountRatio /
 *     topLongShortPositionRatio / takerlongshortRatio / fundingRate）。
 *
 * 铁律 #5：全部为公共无 key 端点，本包不缓存、不再分发数据。
 *
 * 符号词汇（docs/symbol-vocabulary.md）：宽容接受市场规范形（`BTCUSDT` / `BTCUSDT-SWAP`）
 * 与交易所原生形（`BTC-USDT-SWAP`）；输出回显 provider 的规范形。
 *
 * @module @dshtrading/kit-crypto/derivatives
 */

import type { DerivativesData } from '@dshtrading/api'

export interface DerivativesFetchOptions {
  symbol: string
  fetch?: typeof globalThis.fetch
}

export interface DerivativesResult {
  data?: DerivativesData
  unavailable?: string[]
  /** 注册表路径实际供数的 provider（直连回退路径缺省，不回显假 provider）。 */
  provider?: string
}

/** provider 取数失败时的降级结果（fail-soft：与直连路径同一契约，报错不抛裸异常）。 */
export function derivativesFailure(provider: string, error: unknown): DerivativesResult {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? `${(error as { code: string }).code}: ` : ''
  const message = error instanceof Error ? error.message : String(error)
  return { provider, unavailable: [`${provider}-getDerivatives: ${code}${message}`] }
}

const BINANCE_FAPI_BASE = 'https://fapi.binance.com'
const BINANCE_FUTURES_DATA_BASE = 'https://fapi.binance.com/futures/data'

/** 将输入 symbol 规范化为 Binance USDT-M 合约 symbol（如 BTCUSDT）。 */
export function normalizeBinanceFuturesSymbol(raw: string): string {
  const clean = raw.trim().toUpperCase().replace(/[-_]/g, '')
  if (clean.endsWith('SWAP')) {
    return clean.slice(0, -4)
  }
  return clean
}

/** 提取 base 资产名称（如 BTCUSDT → BTC）。 */
export function extractBaseAsset(symbol: string): string {
  const norm = normalizeBinanceFuturesSymbol(symbol)
  const quotes = ['USDT', 'USDC', 'BUSD', 'USD']
  for (const q of quotes) {
    if (norm.endsWith(q) && norm.length > q.length) {
      return norm.slice(0, -q.length)
    }
  }
  return norm
}

export async function fetchCryptoDerivatives(options: DerivativesFetchOptions): Promise<DerivativesResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const symbol = normalizeBinanceFuturesSymbol(options.symbol)
  const unavailable: string[] = []

  let openInterest: number | undefined
  let openInterestValue: number | undefined
  let longShortRatio: number | undefined
  let topTraderLongShortRatio: number | undefined
  let takerBuySellRatio: number | undefined
  let fundingRate: number | undefined
  let timestamp = Date.now()

  // 1. 获取实时 Open Interest
  try {
    const url = `${BINANCE_FAPI_BASE}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (res.ok) {
      const json = (await res.json()) as { openInterest?: string; time?: number }
      if (json.openInterest) openInterest = Number(json.openInterest)
      if (json.time) timestamp = json.time
    } else {
      unavailable.push(`binance-oi: HTTP ${res.status}`)
    }
  } catch (err) {
    unavailable.push(`binance-oi: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. 获取多空人数比 (Global Long/Short Account Ratio)
  try {
    const url = `${BINANCE_FUTURES_DATA_BASE}/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=1h&limit=1`
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (res.ok) {
      const arr = (await res.json()) as Array<{ longShortRatio?: string }>
      if (Array.isArray(arr) && arr.length > 0 && arr[0]?.longShortRatio) {
        longShortRatio = Number(arr[0].longShortRatio)
      }
    } else {
      unavailable.push(`binance-global-ls: HTTP ${res.status}`)
    }
  } catch (err) {
    unavailable.push(`binance-global-ls: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 3. 获取大户多空持仓比 (Top Trader Long/Short Position Ratio)
  try {
    const url = `${BINANCE_FUTURES_DATA_BASE}/topLongShortPositionRatio?symbol=${encodeURIComponent(symbol)}&period=1h&limit=1`
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (res.ok) {
      const arr = (await res.json()) as Array<{ longShortRatio?: string }>
      if (Array.isArray(arr) && arr.length > 0 && arr[0]?.longShortRatio) {
        topTraderLongShortRatio = Number(arr[0].longShortRatio)
      }
    } else {
      unavailable.push(`binance-top-ls: HTTP ${res.status}`)
    }
  } catch (err) {
    unavailable.push(`binance-top-ls: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. 获取 Taker 主动买卖比 (Taker Long/Short Buy/Sell Vol Ratio)
  try {
    const url = `${BINANCE_FUTURES_DATA_BASE}/takerlongshortRatio?symbol=${encodeURIComponent(symbol)}&period=1h&limit=1`
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (res.ok) {
      const arr = (await res.json()) as Array<{ buySellRatio?: string }>
      if (Array.isArray(arr) && arr.length > 0 && arr[0]?.buySellRatio) {
        takerBuySellRatio = Number(arr[0].buySellRatio)
      }
    } else {
      unavailable.push(`binance-taker-vol: HTTP ${res.status}`)
    }
  } catch (err) {
    unavailable.push(`binance-taker-vol: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 5. 获取最新资金费率
  try {
    const url = `${BINANCE_FAPI_BASE}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=1`
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (res.ok) {
      const arr = (await res.json()) as Array<{ fundingRate?: string; fundingTime?: number }>
      if (Array.isArray(arr) && arr.length > 0 && arr[0]?.fundingRate) {
        fundingRate = Number(arr[0].fundingRate)
      }
    } else {
      unavailable.push(`binance-funding: HTTP ${res.status}`)
    }
  } catch (err) {
    unavailable.push(`binance-funding: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 若成功获取至少一项衍生品指标
  if (
    openInterest !== undefined
    || longShortRatio !== undefined
    || topTraderLongShortRatio !== undefined
    || takerBuySellRatio !== undefined
    || fundingRate !== undefined
  ) {
    const data: DerivativesData = {
      symbol: `${symbol}-SWAP`,
      source: 'binance-futures-public',
      openInterest,
      openInterestValue,
      longShortRatio,
      topTraderLongShortRatio,
      takerBuySellRatio,
      fundingRate,
      timestamp,
    }
    return { data, unavailable }
  }

  return { unavailable }
}

export function renderDerivativesData(result: DerivativesResult, requestedSymbol: string): string {
  const { data, unavailable = [], provider } = result
  if (!data) {
    return `crypto_get_derivatives ${requestedSymbol}: no derivative data available.${unavailable.length > 0 ? ` (errors: ${unavailable.join('; ')})` : ''}`
  }

  // provider 只在本调用真的走注册表时回显：直连回退路径不冒名声称路由来源。
  const origin = provider === undefined ? `source: ${data.source}` : `provider: ${provider}, source: ${data.source}`
  const lines: string[] = [
    `crypto_get_derivatives ${data.symbol} (${origin}, updated: ${new Date(data.timestamp).toISOString()}):`,
  ]

  if (data.openInterest !== undefined) {
    lines.push(`- Open Interest (OI): ${data.openInterest.toLocaleString()} base-coins`)
  }
  if (data.openInterestValue !== undefined) {
    lines.push(`- Open Interest Value: ${data.openInterestValue.toLocaleString()} quote`)
  }
  if (data.fundingRate !== undefined) {
    const pct = (data.fundingRate * 100).toFixed(4)
    lines.push(`- Latest Funding Rate: ${data.fundingRate} (${pct}%)`)
  }
  if (data.nextFundingRate !== undefined) {
    const pct = (data.nextFundingRate * 100).toFixed(4)
    lines.push(`- Next Funding Rate: ${data.nextFundingRate} (${pct}%)`)
  }
  if (data.nextFundingTime !== undefined) {
    lines.push(`- Next Funding Time: ${new Date(data.nextFundingTime).toISOString()}`)
  }
  if (data.markPrice !== undefined) {
    lines.push(`- Mark Price: ${data.markPrice}`)
  }
  if (data.indexPrice !== undefined) {
    lines.push(`- Index Price: ${data.indexPrice}`)
  }
  if (data.longShortRatio !== undefined) {
    lines.push(`- Global Long/Short Account Ratio: ${data.longShortRatio.toFixed(2)} (Accounts)`)
  }
  if (data.topTraderLongShortRatio !== undefined) {
    lines.push(`- Top Trader Position L/S Ratio: ${data.topTraderLongShortRatio.toFixed(2)} (Whale Positions)`)
  }
  if (data.takerBuySellRatio !== undefined) {
    lines.push(`- Taker Buy/Sell Volume Ratio: ${data.takerBuySellRatio.toFixed(2)} (Market taker aggressiveness)`)
  }

  if (unavailable.length > 0) {
    lines.push(`  (partially unavailable sub-queries: ${unavailable.join('; ')})`)
  }

  return lines.join('\n')
}
