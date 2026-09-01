/**
 * 路由与标的检索工具（issue #33 / P4，host 平面，全会话可见 D4）：
 * - `routing_get`：各市场当前激活 provider（settings 权威）；
 * - `instruments_search`：跨市场标的检索 = registry 动态全集（listInstruments）
 *   ∪ 内置静态字典（catalog）兜底，按 query 子串过滤。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MarketDataService } from '@dsh-trading/api'
import { SYMBOL_CATALOG } from './catalog.ts'

export const MARKETS: readonly string[] = ['crypto', 'us', 'cn', 'hk']

/** registry + router 的最小消费面（鸭式，与连接器/桥同纪律）。 */
export interface RouterToolServices {
  activeProvider(market: string): string | undefined
  registry?: {
    active(market: string): { provider: string; service: MarketDataService } | undefined
  }
}

/** routing_get 工厂。 */
export function createRoutingGetTool(services: RouterToolServices) {
  return defineTool({
    name: 'routing_get',
    description:
      'Show the currently active market-data provider per market (crypto/us/cn/hk) — the authoritative value comes from '
      + 'the dshtrading settings namespace (dshtrading.markets.<market>.provider). Read-only.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const rows = MARKETS.map((market) => {
        const active = services.registry?.active(market)
        const provider = services.activeProvider(market)
        return {
          market,
          provider: provider ?? null,
          active: active !== undefined,
          activeProvider: active?.provider ?? null,
          note: active === undefined
            ? (provider !== undefined ? 'selected but not registered (connector missing/disabled)' : 'no provider selected')
            : 'serving',
        }
      })
      return JSON.stringify({ ok: true, settings: 'dshtrading.markets.<market>.provider', markets: rows })
    },
  })
}

/** instruments_search 工厂。 */
export function createInstrumentsSearchTool(services: RouterToolServices) {
  return defineTool({
    name: 'instruments_search',
    description:
      'Search tradable instruments across markets (crypto/us/cn/hk) by symbol or name substring, case-insensitive. '
      + 'Results union the routed provider dynamic roster (when it supports listing) with the built-in static catalog. '
      + 'Use a returned entry with watchlist_add / watchlist_select.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Substring to match against symbol or name, e.g. "腾讯" / "BTC" / "apple"',
      },
      market: {
        type: 'string',
        description: 'Optional market filter: crypto | us | cn | hk (default: all markets)',
      },
      limit: {
        type: 'number',
        description: 'Max results per market (default 10, capped at 20)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { query?: unknown; market?: unknown; limit?: unknown }
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      if (!query) {
        throw new Error('instruments_search: query is required')
      }
      const markets = typeof args.market === 'string' && MARKETS.includes(args.market)
        ? [args.market]
        : [...MARKETS]
      const perMarketCap = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.trunc(args.limit), 20)
        : 10

      const results: Array<{ market: string; symbol: string; name?: string; source: 'dynamic' | 'catalog' }> = []
      for (const market of markets) {
        const active = services.registry?.active(market)
        const seen = new Set<string>()
        // 1. 动态全集（listInstruments 可选能力，失败静默跳过）
        if (active !== undefined && typeof active.service.listInstruments === 'function') {
          try {
            const list = await active.service.listInstruments()
            for (const item of list ?? []) {
              const symbol = String(item.symbol ?? '')
              const name = item.name
              if (!symbol || seen.has(symbol)) continue
              const haystack = (symbol + ' ' + (name ?? '')).toLowerCase()
              if (haystack.includes(query)) {
                seen.add(symbol)
                results.push({ market, symbol, ...(name ? { name } : {}), source: 'dynamic' })
              }
              if (seen.size >= perMarketCap) break
            }
          } catch {
            /* 动态全集失败 → 静态字典兜底 */
          }
        }
        // 2. 静态字典兜底（host SSOT）
        for (const entry of SYMBOL_CATALOG[market] ?? []) {
          if (seen.size >= perMarketCap) break
          if (seen.has(entry.symbol)) continue
          const haystack = (entry.symbol + ' ' + entry.name).toLowerCase()
          if (haystack.includes(query)) {
            seen.add(entry.symbol)
            results.push({ market, symbol: entry.symbol, name: entry.name, source: 'catalog' })
          }
        }
      }
      return JSON.stringify({ ok: true, query, total: results.length, results })
    },
  })
}
