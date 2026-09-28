/**
 * Host 面「数据面」行（注册表模式，patch 行 id：dsh-trading-cn-dataplane-xysz）。
 *
 * 只提供行情服务、不注册工具、不 provide 交易服务（星耀数智是纯数据源，无交易通道）。
 * 常态（宿主有 tradingMarketDataRegistry）：enabled=false 硬关；否则在 isolate realm 内
 * 构造服务并 register('cn', 'xysz')——激活裁决推迟到消费方按路由当前值惰性解析
 * （GUI 行情桥热切换）。无注册表的老部署 → 回退直接 provide tradingCnMarketData。
 *
 * 接线：市场 bundle 的 cordis.patch.yml insert 本入口行，见 docs/connector-playbook.md §4。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { ROUTER_PROVIDER, TRADING_CN_MARKET_DATA_KEY, XyszMarketDataService, type Config } from './index.js'

export const inject: string[] = []

// 本行在 patch 里不带 config 时：loader 只认**本模块**导出的 Config 补默认值，缺它就按
// undefined 传入、apply 一读 config.enabled 即崩（2026-09-13 桌面壳实测）。与主行共用
// 同一份 schema，避免两处默认值漂移。
export { Config } from './index.js'

/** 注册表服务的最小消费面（鸭式，连接器对 router 包保持零依赖）。 */
interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

/** 解析注册表服务；老部署（base/router 未升级）返回 undefined → 调用方回退直接 provide。 */
function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

const MARKET = 'cn'

export function apply(ctx: Context, config?: Partial<Config>): void {
  // 手工构造 ctx 的调用方（单测/第三方宿主）可能不传 config：缺省与 index.ts 的 schema 同值。
  if (config?.enabled === false) return
  const options = {
    apiUrl: config?.apiUrl ?? 'http://127.0.0.1:8191',
    timeoutMs: config?.timeoutMs ?? 60_000,
  }
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new XyszMarketDataService(ctx, options)
    return
  }
  const inner = ctx.isolate(TRADING_CN_MARKET_DATA_KEY)
  const service = new XyszMarketDataService(inner, options)
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
