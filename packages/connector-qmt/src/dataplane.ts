import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService, TradeRegistry } from '@dshtrading/api'
import {
  ROUTER_PROVIDER,
  Config,
  QmtMarketDataService,
  QmtTradeService,
  TRADING_CN_MARKET_DATA_KEY,
  TRADING_CN_TRADE_KEY,
} from './index.js'

export const inject: string[] = []

// 本行 patch 行只写 `enabled: true`：loader 只认**本模块**导出的 Config 补默认值
// （cordis resolveConfig：模块无 Config → 行 config 原样传入）。缺它就丢掉 schema 默认
// 值（env/dryRun/liveTrading/gatewayUrl），QmtTradeService 构造时 OrderIntentLedger 拿
// 不到 environment（requireNonEmpty 抛 TypeError）→ 整行 apply 失败 → 行情与交易两个
// 服务都不注册（2026-10-14 实测）。与主行共用同一份 schema，避免默认值漂移。
export { Config }

/** schema 的运行时可调用形态（schemastery 校验即补默认值）；手工 ctx 不传 config 时用。 */
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

const MARKET = 'cn'

export function apply(ctx: Context, config: Config = withDefaults(undefined)): void {
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

