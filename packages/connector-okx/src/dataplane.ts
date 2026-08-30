/**
 * Host 面「数据面」行（2026-08-30 GUI 行情桥配套）：只 provide
 * `tradingCryptoMarketData`，不 provide `tradingCryptoTrade`（交易面需要凭证与
 * 审批闸门，留在 preset 平面）、不注册任何工具。激活语义与 preset 行一致：
 * enabled 开关 + router consult（settings 选谁谁激活，与 binance 数据面行互斥）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { OkxMarketDataService, ROUTER_PROVIDER, type Config, type MarketRouterLike } from './index.ts'

export const inject: string[] = []

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const router = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as MarketRouterLike | undefined
  const active = router?.activeProvider('crypto')
  if (router !== undefined && active !== ROUTER_PROVIDER) return
  new OkxMarketDataService(ctx)
}
