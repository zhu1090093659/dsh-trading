/**
 * Host 面「数据面」行（2026-08-30 注册表模式定稿，架构评审整改 #1）：
 * 只提供行情服务、不注册任何工具——工具面留在 preset 平面（会话隔离铁律）。
 *
 * 注册表模式（有 tradingMarketDataRegistry 时，为常态）：enabled=false 硬关；否则在
 * isolate realm 内构造服务（不占 host 根市场键，binance/okx 并存无互斥冲突）并注册进
 * 注册表。激活裁决推迟到消费方按路由当前值惰性解析（GUI 行情桥每请求解析）——
 * settings 切换交易所即刻生效（GUI 热切换，不再要求重启进程）。
 * 无注册表的老部署 → 回退 2026-08-30 前形态：router consult 互斥激活 + 直接 provide。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dsh-trading/api'
import {
  BinanceMarketDataService,
  ROUTER_PROVIDER,
  TRADING_CRYPTO_MARKET_DATA_KEY,
  routeAllows,
  type Config,
} from './index.ts'
export const inject: string[] = []

/** 注册表服务的最小消费面（鸭式，不定死接口——连接器对 router 包保持零依赖，与 router consult 同纪律）。 */
interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

/** 解析注册表服务；老部署（base/router 未升级）返回 undefined → 调用方回退旧的直接 provide 路径。 */
function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    // 老部署回退：互斥激活 + 直接 provide（settings 切换须重启进程才到 GUI）。
    if (!routeAllows(ctx, config, 'crypto')) return
    new BinanceMarketDataService(ctx)
    return
  }
  const inner = ctx.isolate(TRADING_CRYPTO_MARKET_DATA_KEY)
  const service = new BinanceMarketDataService(inner)
  ctx.effect(() => registry.register('crypto', ROUTER_PROVIDER, service))
}
