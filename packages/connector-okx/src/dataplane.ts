/**
 * Host 面「数据面」行（2026-08-30 注册表模式定稿，架构评审整改 #1）：只提供行情
 * 服务，不 provide `tradingCryptoTrade`（交易面需要凭证与审批闸门，留在 preset
 * 平面）、不注册任何工具。注册表模式/老部署回退两态与 connector-binance 一致
 *（见其 dataplane.ts 头注）。OKX 模拟盘/实盘由 env 配置区分，行情面公共无凭证。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dsh-trading/api'
import {
  OkxMarketDataService,
  ROUTER_PROVIDER,
  TRADING_CRYPTO_MARKET_DATA_KEY,
  type Config,
  type MarketRouterLike,
} from './index.ts'
export const inject: string[] = []

/** 注册表服务的最小消费面（鸭式，不定死接口——连接器对 router 包保持零依赖，与 router consult 同纪律）。 */
interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

/** 解析注册表服务；老部署（base/router 未升级）返回 undefined → 调用方回退旧的直接 provide 路径。 */
function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  // 非严格 get（宿主 α3 / cordis 4.0.2：strict 默认要求 providing fiber 已激活，
  // loader 顺序挂载期兄弟条目 fiber 尚 pending → apply 期旁查必须 non-strict）。
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    // 老部署回退：互斥激活 + 直接 provide（router 旁查同样 non-strict）。
    const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as MarketRouterLike | undefined
    const active = router?.activeProvider('crypto')
    if (router !== undefined && active !== ROUTER_PROVIDER) return
    new OkxMarketDataService(ctx)
    return
  }
  const inner = ctx.isolate(TRADING_CRYPTO_MARKET_DATA_KEY)
  const service = new OkxMarketDataService(inner)
  ctx.effect(() => registry.register('crypto', ROUTER_PROVIDER, service))
}
