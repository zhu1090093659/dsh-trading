/**
 * Host 面「数据面」行（2026-08-30 GUI 行情桥配套）：单包双市场，config.market
 * 分流（cn → tradingCnMarketData / hk → tradingHkMarketData），只 provide 行情
 * 服务、不注册任何工具——工具面留在 preset 平面（会话隔离）。行 id 按市场命名
 * （cn/hk bundle 各插一行），与 preset 平面的同包多实例模式一致。
 */
import type { Context } from '@deepseek-ai/cordis'
import { marketDataKey, TencentMarketDataService, type Config } from './index.ts'

export const inject: string[] = []

export function apply(ctx: Context, config: Config): void {
  const market = config.market
  new TencentMarketDataService(ctx, market, {}, marketDataKey(market))
}
