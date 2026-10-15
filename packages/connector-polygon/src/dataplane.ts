import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { PolygonMarketDataService, ROUTER_PROVIDER, TRADING_US_MARKET_DATA_KEY, Config, createApiKeyProvider } from './index.js'

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

const MARKET = 'us'

export function apply(ctx: Context, config: Config = withDefaults(undefined)): void {
  if (!config.enabled) return
  // 凭证与主入口共用 `createApiKeyProvider`（设置中心 router 凭证优先、`apiKeyRef` 环境变量兜底），
  // 且惰性到**每次请求**解析：本行是 us bundle 在宿主启动时挂载的行情注册面，而 settings 用户层
  // 加载晚于插件 apply——apply 期快照会落空（2026-09-12 实证根因；hithink/tushare 同款）。
  const apiKeyProvider = createApiKeyProvider(ctx, config)
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new PolygonMarketDataService(ctx, { apiKeyProvider })
    return
  }
  const inner = ctx.isolate(TRADING_US_MARKET_DATA_KEY)
  const service = new PolygonMarketDataService(inner, { apiKeyProvider })
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
