/**
 * Host 面「数据面」行（2026-08-30 注册表模式定稿，架构评审整改 #1）：注册 (us, 'yahoo')
 * 进注册表（isolate realm 构造，不占 host 根市场键），激活裁决推迟到消费方按路由当前值
 * 惰性解析（GUI 热切换）；无注册表的老部署回退直接 provide tradingUsMarketData。
 * 只提供行情服务、不注册任何工具——工具面留在 preset 平面（会话隔离铁律）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { Config, ROUTER_PROVIDER, TRADING_US_MARKET_DATA_KEY, YahooMarketDataService } from './index.ts'
export const inject: string[] = []

// 本行 patch 行只写 `enabled: true`：loader 只认**本模块**导出的 Config 补默认值
// （cordis resolveConfig——模块无 Config 时行 config 原样传入，schema 默认值全部丢失）。
// 与主行共用同一份 schema，默认值不出现第二个家（docs/guides/connector-playbook.md §4.2）。
// Yahoo 是纯数据源：无交易面、schema 里也没有行级开关，故 apply 不吃 config（本行恒注册）。
export { Config }

/** 注册表服务的最小消费面（鸭式，不定死接口——连接器对 router 包保持零依赖，与 router consult 同纪律）。 */
interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

/** 解析注册表服务；老部署（base/router 未升级）返回 undefined → 调用方回退旧的直接 provide 路径。 */
function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

export function apply(ctx: Context): void {
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new YahooMarketDataService(ctx)
    return
  }
  const inner = ctx.isolate(TRADING_US_MARKET_DATA_KEY)
  const service = new YahooMarketDataService(inner)
  ctx.effect(() => registry.register('us', ROUTER_PROVIDER, service))
}
