/**
 * Host 面「数据面」行（2026-08-30 GUI 行情桥配套）：只 provide
 * `tradingUsMarketData`，不注册任何工具——工具面留在 preset 平面（会话隔离）。
 * us 市场现无第二数据源候选，与 preset 行同形态直接 provide。
 */
import type { Context } from '@deepseek-ai/cordis'
import { YahooMarketDataService } from './index.ts'

export const inject: string[] = []

export function apply(ctx: Context): void {
  new YahooMarketDataService(ctx)
}
