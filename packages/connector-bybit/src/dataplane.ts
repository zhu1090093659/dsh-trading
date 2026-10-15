import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService, TradeRegistry } from '@dshtrading/api'
import {
  BybitMarketDataService,
  BybitTradeService,
  ROUTER_PROVIDER,
  TRADING_CRYPTO_MARKET_DATA_KEY,
  TRADING_CRYPTO_TRADE_KEY,
  Config,
} from './index.js'

export const inject: string[] = []

// 本行 patch 行只写 `enabled: true` 等少量键：loader 只认**本模块**导出的 Config 补默认值
// （cordis resolveConfig——模块无 Config 时行 config 原样传入，schema 默认值全部丢失）。
// 与主行共用同一份 schema，默认值不出现第二个家（docs/guides/connector-playbook.md §4.2）。
export { Config }

/** schema 的运行时可调用形态（校验即补默认值）；手工构造 ctx 不传 config 时按 schema 默认值处理。 */
const withDefaults = (value: unknown): Config => (Config as unknown as (v: unknown) => Config)(value)

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

const MARKET = 'crypto'

export function apply(ctx: Context, config: Config = withDefaults(undefined)): void {
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

