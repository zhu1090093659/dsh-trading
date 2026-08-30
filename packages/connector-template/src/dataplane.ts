/**
 * 【模板】Host 面「数据面」行（2026-08-30 注册表模式，架构评审整改 #1）：
 * 只提供行情服务、不注册工具、不 provide 交易服务（交易面需要凭证与审批闸门，
 * 留在 preset 平面）。
 *
 * 常态（宿主有 tradingMarketDataRegistry，@dsh-trading/router 提供）：enabled=false
 * 硬关；否则在 isolate realm 内构造服务（不占 host 根市场键，多连接器并存无互斥
 * 冲突）并 register(__MARKET__, '__EXCHANGE_SLUG__')——激活裁决推迟到消费方按路由
 * 当前值惰性解析（GUI 行情桥每请求解析，settings 切换交易所即刻生效）。
 * 无注册表的老部署 → 回退直接 provide 市场键（旧桥消费，settings 切换须重启到 GUI）。
 *
 * 接线：市场 bundle 的 cordis.patch.yml insert 本入口行（enabled: true 等行 config
 * 必须 restate——整行替换语义），见 docs/connector-playbook.md §4。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dsh-trading/api'
import { __EXCHANGE__MarketDataService, TRADING_MARKET_DATA_KEY, type Config } from './index.js'

export const inject: string[] = []

/** 注册表服务的最小消费面（鸭式，不定死接口——连接器对 router 包保持零依赖）。 */
interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

/** 解析注册表服务；老部署（base/router 未升级）返回 undefined → 调用方回退直接 provide。 */
function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketDataRegistry')
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

/** 本连接器的路由 provider slug（路由层词汇 = 交易所 slug，docs/exchange-routing.md §2.2）。 */
const ROUTER_PROVIDER = '__EXCHANGE_SLUG__'
/** 市场短前缀（与 index.ts 的 MARKET 一致；模板未展开也可编译）。 */
const MARKET = '__MARKET__'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new __EXCHANGE__MarketDataService(ctx)
    return
  }
  const inner = ctx.isolate(TRADING_MARKET_DATA_KEY)
  const service = new __EXCHANGE__MarketDataService(inner)
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
