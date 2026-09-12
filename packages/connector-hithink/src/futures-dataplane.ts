import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { TRADING_FUTURES_MARKET_DATA_KEY, HiThinkFuturesMarketDataService } from './futures.js'
import type { Config } from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

const ROUTER_PROVIDER = 'hithink'
const MARKET = 'futures'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const apiKey = process.env[config.apiKeyRef]
  const registry = resolveMarketDataRegistry(ctx)
  const opts = apiKey ? { apiKey } : {}
  if (registry === undefined) {
    new HiThinkFuturesMarketDataService(ctx, opts)
    return
  }
  const inner = ctx.isolate(TRADING_FUTURES_MARKET_DATA_KEY)
  const service = new HiThinkFuturesMarketDataService(inner, opts)
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
