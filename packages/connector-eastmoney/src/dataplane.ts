import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { EastmoneyMarketDataService, marketDataKey, type Config } from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

const ROUTER_PROVIDER = 'eastmoney'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const market = config.market ?? 'cn'
  const key = marketDataKey(market)
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new EastmoneyMarketDataService(ctx, { market }, key)
    return
  }
  const inner = ctx.isolate(key)
  const service = new EastmoneyMarketDataService(inner, { market }, key)
  ctx.effect(() => registry.register(market, ROUTER_PROVIDER, service))
}
