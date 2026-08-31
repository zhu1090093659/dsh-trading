import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dsh-trading/api'
import { BybitMarketDataService, TRADING_CRYPTO_MARKET_DATA_KEY, type Config } from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketDataRegistry')
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
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
}
