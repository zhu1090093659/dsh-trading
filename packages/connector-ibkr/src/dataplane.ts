import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dsh-trading/api'
import { IbkrMarketDataService, TRADING_US_MARKET_DATA_KEY, type Config } from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

const ROUTER_PROVIDER = 'ibkr'
const MARKET = 'us'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new IbkrMarketDataService(ctx, { gatewayUrl: config.gatewayUrl, accountId: config.accountId })
    return
  }
  const inner = ctx.isolate(TRADING_US_MARKET_DATA_KEY)
  const service = new IbkrMarketDataService(inner, { gatewayUrl: config.gatewayUrl, accountId: config.accountId })
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
