import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dsh-trading/api'
import { FinnhubMarketDataService, TRADING_US_MARKET_DATA_KEY, type Config } from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

const ROUTER_PROVIDER = 'finnhub'
const MARKET = 'us'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const apiKey = process.env[config.apiKeyRef]
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new FinnhubMarketDataService(ctx, { apiKey })
    return
  }
  const inner = ctx.isolate(TRADING_US_MARKET_DATA_KEY)
  const service = new FinnhubMarketDataService(inner, { apiKey })
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
