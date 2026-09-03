/**
 * crypto_get_fundamentals 取数与聚合层（WS4 代币经济学与基本面数据面）。
 *
 * 直连公共无 key 端点（符合铁律 #5：不缓存不分发，个人使用公共统计数据）：
 *   - CoinCap 公共 REST API：https://api.coincap.io/v2/assets?search=...
 *     - rank（全球市值排名）
 *     - marketCapUsd（流通市值）
 *     - supply（流通供应量）
 *     - maxSupply（最大供应量）
 *     - volumeUsd24Hr（24h 成交额）
 *   - Binance 24hr Ticker 公共 REST：https://api.binance.com/api/v3/ticker/24hr
 *     - 24h 交易量、成交笔数、价格涨跌幅补充
 *
 * @module @dshtrading/kit-crypto/fundamentals
 */

import type { CryptoFundamentals } from '@dshtrading/api'
import { extractBaseAsset, normalizeBinanceFuturesSymbol } from './derivatives.js'

export interface CryptoFundamentalsOptions {
  symbol: string
  fetch?: typeof globalThis.fetch
}

export interface CryptoFundamentalsResult {
  data?: CryptoFundamentals
  quoteVolume24h?: number
  priceChangePercent24h?: number
  tradesCount24h?: number
  unavailable?: string[]
}

const COINCAP_API_BASE = 'https://api.coincap.io/v2'
const BINANCE_API_BASE = 'https://api.binance.com'

/** 上游超时（2026-09-02 整改）：防公共端点挂起拖死桥请求。 */
const UPSTREAM_TIMEOUT_MS = 10_000

const COMMON_COIN_ID_MAP: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binance-coin',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  DOT: 'polkadot',
  LINK: 'chainlink',
  MATIC: 'polygon',
  POL: 'polygon-ecosystem-token',
  NEAR: 'near',
  SUI: 'sui',
  APT: 'aptos',
  PEPE: 'pepe',
  SHIB: 'shiba-inu',
  UNI: 'uniswap',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
}

interface CoinCapAsset {
  id: string
  rank: string
  symbol: string
  name: string
  supply: string
  maxSupply: string | null
  marketCapUsd: string
  volumeUsd24Hr: string
  priceUsd: string
  changePercent24Hr: string
}

async function fetchCoinCapAsset(base: string, fetchImpl: typeof globalThis.fetch): Promise<CoinCapAsset | undefined> {
  const directId = COMMON_COIN_ID_MAP[base]
  if (directId) {
    try {
      const res = await fetchImpl(`${COINCAP_API_BASE}/assets/${directId}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
      if (res.ok) {
        const json = (await res.json()) as { data?: CoinCapAsset }
        if (json.data) return json.data
      }
    } catch {
      // 降级到搜索
    }
  }

  // 搜索端点
  const res = await fetchImpl(`${COINCAP_API_BASE}/assets?search=${encodeURIComponent(base)}&limit=5`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const json = (await res.json()) as { data?: CoinCapAsset[] }
  const list = json.data ?? []
  return list.find((item) => item.symbol.toUpperCase() === base) ?? list[0]
}

export async function fetchCryptoFundamentals(options: CryptoFundamentalsOptions): Promise<CryptoFundamentalsResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const rawSymbol = options.symbol.trim().toUpperCase()
  const base = extractBaseAsset(rawSymbol)
  const binancePair = `${base}USDT`
  const unavailable: string[] = []

  let coincapAsset: CoinCapAsset | undefined
  try {
    coincapAsset = await fetchCoinCapAsset(base, fetchImpl)
  } catch (err) {
    unavailable.push(`coincap: ${err instanceof Error ? err.message : String(err)}`)
  }

  let quoteVolume24h: number | undefined
  let priceChangePercent24h: number | undefined
  let tradesCount24h: number | undefined

  try {
    const res = await fetchImpl(`${BINANCE_API_BASE}/api/v3/ticker/24hr?symbol=${encodeURIComponent(binancePair)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (res.ok) {
      const ticker = (await res.json()) as {
        quoteVolume?: string
        priceChangePercent?: string
        count?: number
      }
      if (ticker.quoteVolume) quoteVolume24h = Number(ticker.quoteVolume)
      if (ticker.priceChangePercent) priceChangePercent24h = Number(ticker.priceChangePercent)
      if (ticker.count !== undefined) tradesCount24h = ticker.count
    } else {
      unavailable.push(`binance-24hr: HTTP ${res.status}`)
    }
  } catch (err) {
    unavailable.push(`binance-24hr: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (coincapAsset) {
    const rank = Number(coincapAsset.rank)
    const marketCapUsd = Number(coincapAsset.marketCapUsd)
    const circulatingSupply = Number(coincapAsset.supply)
    const totalSupply = coincapAsset.maxSupply ? Number(coincapAsset.maxSupply) : undefined
    const volume24hUsd = Number(coincapAsset.volumeUsd24Hr)
    const priceUsd = Number(coincapAsset.priceUsd)
    const fdvUsd = totalSupply && Number.isFinite(priceUsd) ? totalSupply * priceUsd : undefined

    const data: CryptoFundamentals = {
      symbol: rawSymbol,
      name: coincapAsset.name,
      rank: Number.isFinite(rank) ? rank : undefined,
      marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : undefined,
      fdvUsd: fdvUsd && Number.isFinite(fdvUsd) ? fdvUsd : undefined,
      circulatingSupply: Number.isFinite(circulatingSupply) ? circulatingSupply : undefined,
      totalSupply: totalSupply && Number.isFinite(totalSupply) ? totalSupply : undefined,
      volume24hUsd: Number.isFinite(volume24hUsd) ? volume24hUsd : undefined,
      timestamp: Date.now(),
    }
    return { data, quoteVolume24h, priceChangePercent24h, tradesCount24h, unavailable }
  }

  if (quoteVolume24h !== undefined) {
    const data: CryptoFundamentals = {
      symbol: rawSymbol,
      name: base,
      volume24hUsd: quoteVolume24h,
      timestamp: Date.now(),
    }
    return { data, quoteVolume24h, priceChangePercent24h, tradesCount24h, unavailable }
  }

  return { unavailable }
}

/** 获取完整加密资产基本面数据包。 */
export async function fetchCryptoFundamentalsPackage(symbol: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<import('@dshtrading/api').FundamentalsPackage> {
  const quoteRes = await fetchCryptoFundamentals({ symbol, fetch: fetchImpl })
  const base = extractBaseAsset(symbol)

  return {
    market: 'crypto',
    symbol,
    crypto: quoteRes.data,
    profile: {
      symbol,
      name: quoteRes.data?.name ?? base,
      industry: 'Blockchain / Cryptocurrency',
      sector: 'Digital Asset',
      description: `${quoteRes.data?.name ?? base} 是全球主流加密数字资产，提供去中心化网络价值与交易结算能力。`,
    },
  }
}

export function renderCryptoFundamentals(result: CryptoFundamentalsResult, requestedSymbol: string): string {
  const { data, quoteVolume24h, priceChangePercent24h, tradesCount24h, unavailable = [] } = result
  if (!data) {
    return `crypto_get_fundamentals ${requestedSymbol}: no fundamental data available.${unavailable.length > 0 ? ` (errors: ${unavailable.join('; ')})` : ''}`
  }

  const lines: string[] = [
    `crypto_get_fundamentals ${data.symbol}${data.name ? ` (${data.name})` : ''}:`,
  ]

  if (data.rank !== undefined) {
    lines.push(`- Global Market Cap Rank: #${data.rank}`)
  }
  if (data.marketCapUsd !== undefined) {
    lines.push(`- Market Cap: \$${data.marketCapUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} USD`)
  }
  if (data.fdvUsd !== undefined) {
    lines.push(`- Fully Diluted Valuation (FDV): \$${data.fdvUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} USD`)
  }
  if (data.circulatingSupply !== undefined) {
    lines.push(`- Circulating Supply: ${data.circulatingSupply.toLocaleString()} coins`)
  }
  if (data.totalSupply !== undefined) {
    lines.push(`- Total / Max Supply: ${data.totalSupply.toLocaleString()} coins`)
  }
  if (data.volume24hUsd !== undefined) {
    lines.push(`- 24h Volume (Global): \$${data.volume24hUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} USD`)
  }
  if (priceChangePercent24h !== undefined) {
    lines.push(`- 24h Price Change: ${priceChangePercent24h > 0 ? '+' : ''}${priceChangePercent24h.toFixed(2)}%`)
  }
  if (tradesCount24h !== undefined) {
    lines.push(`- 24h Trades Count (Binance Spot): ${tradesCount24h.toLocaleString()} trades`)
  }

  if (unavailable.length > 0) {
    lines.push(`  (partially unavailable sources: ${unavailable.join('; ')})`)
  }

  return lines.join('\n')
}
