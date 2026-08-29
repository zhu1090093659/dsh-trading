/**
 * Binance 连接器插件骨架（dsh-trading crypto 切片）。
 *
 * 形态 = 官方插件三件套：命名导出 `name` / `inject` / `apply`（skill-badge 形态，
 * TEMPLATES §4；Config schema 用 @deepseek-ai/schemastery）。本骨架只注册占位工具
 * `crypto_get_ticker`；MarketDataService 实现（REST+WS）、`crypto_get_klines`、
 * 凭证接入（ctx.credentials 按名引用，BYOK [S4]）在后续任务落地。
 *
 * @module @dsh-trading/connector-binance
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Cordis 插件名 = patch 行 id（TEMPLATES §8）：`dsh-trading-crypto-*` 市场命名空间，
 * 全仓唯一，绝不使用 `base` 等官方保留 id（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-crypto-connector-binance'

export interface Config {
  /** 交易安全闸门（铁律 #3）：true 时下单类工具强制 dry-run。 */
  dryRun: boolean
  /** 实盘总闸门：默认 false；false 时无论 dryRun 与否都拒绝实盘下单 [S4]。 */
  liveTrading: boolean
}

export const Config: Schema<Config> = Schema.object({
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
})

/** 需要宿主提供的 Cordis 服务。 */
export const inject = ['tools']

export function apply(ctx: Context): void {
  // 注册即 effect，插件卸载自动清理（官方 framework 语义）。
  ctx.tools.register(
    defineTool({
      name: 'crypto_get_ticker',
      description:
        'Get the latest public ticker (last price, bid/ask, 24h volume) for a crypto symbol via the Binance public REST API. No credentials required.',
      parameters: {
        symbol: {
          type: 'string',
          required: true,
          description: 'Trading pair symbol, e.g. BTCUSDT',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        // 占位：真实实现在「第 1 阶段第 3 步」——经市场命名空间 ctx 键（如 ctx.tradingCrypto）
        // 调用 MarketDataService.getTicker（公共接口，无需凭证）。
        throw new Error('crypto_get_ticker: not implemented (scaffold stub)')
      },
    }),
  )
}
