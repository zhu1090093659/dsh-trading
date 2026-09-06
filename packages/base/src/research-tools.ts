/** Agent-plane read-only market tools. No connector/trade service is mounted here. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Interval, MarketDataService } from '@dshtrading/api'
export const name = 'dsh-trading-research-market-data'
export const inject = ['tools']
export interface Config { markets: string[] }
export const Config: Schema<Config> = Schema.object({
  markets: Schema.array(Schema.union(['crypto', 'us', 'cn', 'hk'])).default([]),
})
interface Registry { active(market: string): { provider: string; service: MarketDataService } | undefined }
const INTERVALS: Interval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']
export function createResearchTools(market: string, getRegistry: () => Registry | undefined) {
  const active = () => {
    const entry = getRegistry()?.active(market)
    if (!entry) throw new Error(`${market}: selected market data provider unavailable; check routing_get and installed connectors`)
    return entry
  }
  const symbolParam = { type: 'string' as const, required: true, description: 'Market-canonical symbol, e.g. BTCUSDT / AAPL / 600519.SH / 00700.HK' }
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  return [
    defineTool({
      name: `${market}_get_ticker`,
      description: `Read-only ${market} quote from the currently routed project data provider. Check timestamp, currency and provider; quotes may be delayed.`,
      parameters: { symbol: symbolParam }, output,
      async execute(args) {
        const entry = active()
        const ticker = await entry.service.getTicker(String(args.symbol))
        return JSON.stringify({ market, provider: entry.provider, ticker })
      },
    }),
    defineTool({
      name: `${market}_get_klines`,
      description: `Read-only ${market} OHLCV candles from the currently routed project data provider. Unsupported intervals fail explicitly; never substitutes another source.`,
      parameters: {
        symbol: symbolParam,
        interval: { type: 'string', enum: INTERVALS, default: '1d', description: 'Candle interval; provider support varies.' },
        limit: { type: 'number', default: 200, description: 'Maximum candles, integer 1–1000.' },
      }, output,
      async execute(args) {
        const limit = Number(args.limit ?? 200)
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be an integer from 1 to 1000')
        const entry = active()
        const klines = await entry.service.getKlines(String(args.symbol), (args.interval ?? '1d') as Interval, limit)
        return JSON.stringify({ market, provider: entry.provider, klines })
      },
    }),
  ]
}
export function apply(ctx: Context, config: Config): void {
  for (const market of new Set(config.markets)) {
    for (const tool of createResearchTools(market, () => ctx.get('tradingMarketDataRegistry') as Registry | undefined)) {
      ctx.tools.register(tool)
    }
  }
}
