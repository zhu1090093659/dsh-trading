import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService, TradeRegistry } from '@dshtrading/api'
import {
  BybitMarketDataService,
  BybitTradeService,
  TRADING_CRYPTO_MARKET_DATA_KEY,
  TRADING_CRYPTO_TRADE_KEY,
  type Config,
} from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

function resolveTradeRegistry(ctx: Context): TradeRegistry | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingTradeRegistry', false)
  return candidate !== undefined ? (candidate as TradeRegistry) : undefined
}

const ROUTER_PROVIDER = 'bybit'
const MARKET = 'crypto'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const apiKey = process.env[config.apiKeyRef]
  const apiSecret = process.env[config.secretRef]
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new BybitMarketDataService(ctx, { apiKey, apiSecret })
    return
  }
  const inner = ctx.isolate(TRADING_CRYPTO_MARKET_DATA_KEY)
  const service = new BybitMarketDataService(inner, { apiKey, apiSecret })
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))

  const tradeRegistry = resolveTradeRegistry(ctx)
  if (tradeRegistry !== undefined) {
    const tradeInner = ctx.isolate(TRADING_CRYPTO_TRADE_KEY)
    const trade = new BybitTradeService(tradeInner, { apiKey, apiSecret, config })
    ctx.effect(() => tradeRegistry.register(MARKET, ROUTER_PROVIDER, trade))
  }
}

