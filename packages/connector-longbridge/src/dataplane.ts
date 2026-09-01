import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dsh-trading/api'
import { LongbridgeMarketDataService, TRADING_HK_MARKET_DATA_KEY, type Config } from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

const ROUTER_PROVIDER = 'longbridge'
const MARKET = 'hk'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const appKey = process.env[config.appKeyRef]
  const appSecret = process.env[config.appSecretRef]
  const accessToken = process.env[config.accessTokenRef]
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new LongbridgeMarketDataService(ctx, { appKey, appSecret, accessToken })
    return
  }
  const inner = ctx.isolate(TRADING_HK_MARKET_DATA_KEY)
  const service = new LongbridgeMarketDataService(inner, { appKey, appSecret, accessToken })
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
