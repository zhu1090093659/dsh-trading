import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { ROUTER_PROVIDER, LongbridgeMarketDataService, TRADING_HK_MARKET_DATA_KEY, Config, resolveCredentials } from './index.js'

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

const MARKET = 'hk'

export function apply(ctx: Context, config: Config = withDefaults(undefined)): void {
  if (!config.enabled) return
  // 凭证与 preset 行同源（resolveCredentials：settings 优先、env 兜底）——本行是 hk
  // bundle 挂载的行情注册面，面板填的 key 必须在这里也生效，否则 GUI 行情读不到它。
  const { appKey, appSecret, accessToken } = resolveCredentials(ctx, config)
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new LongbridgeMarketDataService(ctx, { appKey, appSecret, accessToken })
    return
  }
  const inner = ctx.isolate(TRADING_HK_MARKET_DATA_KEY)
  const service = new LongbridgeMarketDataService(inner, { appKey, appSecret, accessToken })
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
