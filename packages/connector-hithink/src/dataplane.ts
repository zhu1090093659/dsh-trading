import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { HiThinkMarketDataService, TRADING_CN_MARKET_DATA_KEY, type Config } from './index.js'

export const inject: string[] = []

interface MarketDataRegistryLike {
  register(market: string, provider: string, service: MarketDataService): () => void
}

function resolveMarketDataRegistry(ctx: Context): MarketDataRegistryLike | undefined {
  const candidate = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketDataRegistry', false)
  return candidate !== undefined ? (candidate as MarketDataRegistryLike) : undefined
}

const ROUTER_PROVIDER = 'hithink'
const MARKET = 'cn'

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  // 凭证对齐 tushare 等商业连接器（2026-09-12 实证修复）：设置中心
  // dshtrading.credentials.hithink.apiKey 优先、env 兜底，惰性到每次请求解析
  // （settings 用户层加载/修改晚于插件 apply 亦生效，热切换即时生效）。
  const apiKeyProvider = (): string | undefined => {
    const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as
      | { getCredential?(provider: string): Record<string, string> | undefined }
      | undefined
    return router?.getCredential?.('hithink')?.apiKey || process.env[config.apiKeyRef]
  }
  const registry = resolveMarketDataRegistry(ctx)
  const opts = { apiKeyProvider }
  if (registry === undefined) {
    new HiThinkMarketDataService(ctx, opts)
    return
  }
  const inner = ctx.isolate(TRADING_CN_MARKET_DATA_KEY)
  const service = new HiThinkMarketDataService(inner, opts)
  ctx.effect(() => registry.register(MARKET, ROUTER_PROVIDER, service))
}
