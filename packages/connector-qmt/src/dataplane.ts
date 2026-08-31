import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dsh-trading/api'
import { QmtMarketDataService, TRADING_CN_MARKET_DATA_KEY, type Config } from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketDataRegistry')
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

const ROUTER_PROVIDER = 'qmt'
const MARKET = 'cn'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new QmtMarketDataService(ctx, { gatewayUrl: config.gatewayUrl, accountId: config.accountId })
    return
  }
  const inner = ctx.isolate(TRADING_CN_MARKET_DATA_KEY)
  const service = new QmtMarketDataService(inner, { gatewayUrl: config.gatewayUrl, accountId: config.accountId })
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
