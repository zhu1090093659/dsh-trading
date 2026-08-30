/**
 * Host 面「数据面」行（2026-08-30 GUI 行情桥配套，docs/connector-playbook 之外的新
 * 入口形态）：只 provide `tradingCryptoMarketData`，**不注册任何工具**——工具面留在
 * preset 平面（agent.cordis.yml，会话隔离铁律）。供 @dsh-trading/client-ui-trading
 * 的 /dshtrading/api 桥在进程根作用域消费，让交易 GUI 无需先开 agent 会话即可拉行情。
 *
 * 激活语义与 preset 行完全一致：routeAllows 三态（无 router → enabled 语义；
 * router 选中本连接器 → 放行；选中别人/未设置 → 拒绝），binance/okx 数据面行并存、
 * 由 settings 路由裁决（crypto-trader preset 同形态）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BinanceMarketDataService, routeAllows, type Config } from './index.ts'

export const inject: string[] = []

export function apply(ctx: Context, config: Config): void {
  if (!routeAllows(ctx, config, 'crypto')) return
  new BinanceMarketDataService(ctx)
}
