import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { ROUTER_PROVIDER, TushareMarketDataService, TRADING_CN_MARKET_DATA_KEY, Config, createTokenProvider } from './index.js'

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

const MARKET = 'cn'

export function apply(ctx: Context, config: Config = withDefaults(undefined)): void {
  if (!config.enabled) return
  // 凭证与主入口共用 `createTokenProvider`（设置中心 router 凭证优先、env 兜底），且惰性到
  // 每次请求：修复「设置页填了 Token 但宿主面数据行用不到」——settings 用户层加载/修改
  // 晚于本行 apply 亦生效（hithink/jin10 同款，2026-09-12 实证根因）。
  const tokenProvider = createTokenProvider(ctx, config.tokenRef)
  const registry = resolveMarketDataRegistry(ctx)
  if (registry === undefined) {
    new TushareMarketDataService(ctx, { tokenProvider })
    return
  }
  const inner = ctx.isolate(TRADING_CN_MARKET_DATA_KEY)
  const service = new TushareMarketDataService(inner, { tokenProvider })
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
