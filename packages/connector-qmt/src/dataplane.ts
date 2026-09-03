import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService, TradeRegistry } from '@dsh-trading/api'
import {
  QmtMarketDataService,
  QmtTradeService,
  TRADING_CN_MARKET_DATA_KEY,
  TRADING_CN_TRADE_KEY,
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

  const tradeRegistry = resolveTradeRegistry(ctx)
  if (tradeRegistry !== undefined) {
    const tradeInner = ctx.isolate(TRADING_CN_TRADE_KEY)
    const trade = new QmtTradeService(tradeInner, { gatewayUrl: config.gatewayUrl, accountId: config.accountId, config })
    ctx.effect(() => tradeRegistry.register(MARKET, ROUTER_PROVIDER, trade))
  }
}

