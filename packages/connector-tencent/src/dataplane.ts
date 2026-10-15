/**
 * Host 面「数据面」行（2026-08-30 注册表模式定稿，架构评审整改 #1）：单包双市场，
 * config.market 分流（cn/hk 各一行）。注册表模式下两个实例各注册 (market, 'tencent')，
 * 激活裁决推迟到消费方按路由当前值惰性解析（GUI 热切换）；无注册表的老部署回退
 * 直接 provide 市场键（cn → tradingCnMarketData / hk → tradingHkMarketData）。
 * 只提供行情服务、不注册任何工具——工具面留在 preset 平面（会话隔离铁律）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { ROUTER_PROVIDER, TencentMarketDataService, marketDataKey, Config } from './index.ts'
export const inject: string[] = []

// 本行 patch 行只写 `enabled: true` 等少量键：loader 只认**本模块**导出的 Config 补默认值
// （cordis resolveConfig——模块无 Config 时行 config 原样传入，schema 默认值全部丢失）。
// 与主行共用同一份 schema，默认值不出现第二个家（docs/guides/connector-playbook.md §4.2）。
export { Config }

/** schema 的运行时可调用形态（校验即补默认值）；手工构造 ctx 不传 config 时按 schema 默认值处理。 */
const withDefaults = (value: unknown): Config => (Config as unknown as (v: unknown) => Config)(value)

/** 注册表服务的最小消费面（鸭式，不定死接口——连接器对 router 包保持零依赖，与 router consult 同纪律）。 */
interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

/** 解析注册表服务；老部署（base/router 未升级）返回 undefined → 调用方回退旧的直接 provide 路径。 */
function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}
export function apply(ctx: Context, config: Config = withDefaults(undefined)): void {
  const market = config.market
  const key = marketDataKey(market)
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new TencentMarketDataService(ctx, market, {}, key)
    return
  }
  const inner = ctx.isolate(key)
  const service = new TencentMarketDataService(inner, market, {}, key)
  ctx.effect(() => registry.register(market, ROUTER_PROVIDER, service))
}
