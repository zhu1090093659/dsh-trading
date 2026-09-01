import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dsh-trading/api'
import { TushareMarketDataService, TRADING_CN_MARKET_DATA_KEY, type Config } from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

const ROUTER_PROVIDER = 'tushare'
const MARKET = 'cn'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const token = process.env[config.tokenRef]
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new TushareMarketDataService(ctx, { token })
    return
  }
  const inner = ctx.isolate(TRADING_CN_MARKET_DATA_KEY)
  const service = new TushareMarketDataService(inner, { token })
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
