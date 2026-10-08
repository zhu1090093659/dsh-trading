/**
 * 路由与标的检索工具（issue #33 / P4，host 平面，全会话可见 D4）：
 * - `routing_get`：各市场当前激活 provider（settings 权威）；
 * - `instruments_search`：跨市场标的检索 = registry 动态全集（listInstruments）
 *   ∪ 内置静态字典（catalog）兜底，按 query 子串过滤。响应带形态（`form`，缺省
 *   现货）与资产类别（`assetClass`），可按 `type=spot|perp` 过滤；形态判据复用
 *   `@dshtrading/api` 的 `instrumentFormOf`（唯一致裁决实现，不各写一份后缀匹配）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { instrumentFormOf, type InstrumentAssetClass, type InstrumentForm, type MarketDataService } from '@dshtrading/api'
import { SYMBOL_CATALOG, type CatalogMarket } from './catalog.ts'

/** instruments_search / routing_get 覆盖的市场（与内置字典的键同词汇）。 */
export const MARKETS: readonly CatalogMarket[] = ['crypto', 'us', 'cn', 'hk']

/** market 参数收窄：只认已登记的四市场（其余按「不过滤」处理，与既有行为一致）。 */
function isSearchMarket(value: unknown): value is CatalogMarket {
  return typeof value === 'string' && (MARKETS as readonly string[]).includes(value)
}

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

/** 检索命中行（动态名册 ∪ 静态字典）。 */
interface SearchCandidate {
  market: string
  symbol: string
  name?: string
  form: InstrumentForm
  assetClass?: InstrumentAssetClass
  source: 'dynamic' | 'catalog'
}

/** 文本匹配档位：0 = symbol 前缀、1 = symbol 包含、2 = 名称/拼音包含（越小越靠前）。 */
type MatchTier = 0 | 1 | 2

interface RankedCandidate extends SearchCandidate {
  exact: boolean
  tier: MatchTier
  /** 收集顺序（稳定排序的末位判据：动态名册先于静态字典）。 */
  seq: number
}

/** 排序资产类别档位：显式 crypto(0) → 未标注(1) → 已标注非 crypto(2)。 */
function assetClassRank(assetClass: InstrumentAssetClass | undefined): number {
  if (assetClass === 'crypto') return 0
  if (assetClass === undefined) return 1
  return 2
}

/**
 * 截断时的形态覆盖（P4 判据「现货与永续都能出现且不被截断吞掉」）：命中过多时，
 * 若前 cap 条只剩单一形态，就用另一种形态里排最前的候选换掉末位那条「同形态已有
 * 多个代表」的行——结果集大小与排序都保持稳定，也不无中生有（没有候选就不换）。
 */
function coverForms(ranked: RankedCandidate[], cap: number): RankedCandidate[] {
  const top = ranked.slice(0, cap)
  if (cap < 2) return top
  const chosen = new Set(top)
  for (const form of ['spot', 'perp'] as const) {
    if (top.some((c) => c.form === form)) continue
    const cover = ranked.find((c) => c.form === form)
    if (cover === undefined) continue
    const victim = [...top].reverse().find((c) => top.filter((x) => x.form === c.form).length > 1)
    if (victim === undefined) continue
    chosen.delete(victim)
    chosen.add(cover)
  }
  return ranked.filter((c) => chosen.has(c))
}

/** instruments_search 工厂。 */
export function createInstrumentsSearchTool(services: RouterToolServices) {
  return defineTool({
    name: 'instruments_search',
    description:
      'Search tradable instruments across markets (crypto/us/cn/hk) by symbol or name substring, case-insensitive. '
      + 'Crypto carries two forms inside one market: spot (BTCUSDT) and perpetual (BTCUSDT-SWAP) — the -SWAP suffix '
      + 'is the canonical perpetual form, and only the suffix decides the form (no extra form argument is needed for '
      + 'quotes/K-lines). TradFi perpetuals such as TSLAUSDT-SWAP / XAUUSDT-SWAP are exchange-synthesised contracts, '
      + 'not the stock or the commodity itself. Each result carries form (spot/perp, default spot) and, when the '
      + 'exchange metadata provides it, assetClass (crypto/equity/commodity/index). Results union the routed '
      + 'provider dynamic roster (when it supports listing) with the built-in static catalog; exact matches and '
      + 'crypto instruments rank first, and both forms stay visible when results are truncated. '
      + 'The response reports total (rows returned) and matched (hits before the per-market cap). '
      + 'Use a returned symbol with watchlist_add / watchlist_select.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Substring to match against symbol or name, e.g. "腾讯" / "BTC" / "BTCUSDT-SWAP" / "TSLA".',
      },
      market: {
        type: 'string',
        description: 'Optional market filter: crypto | us | cn | hk (default: all markets)',
      },
      type: {
        type: 'string',
        enum: ['spot', 'perp'],
        description: 'Optional form filter: "spot" (no suffix) or "perp" (canonical symbol ends with -SWAP). Default: both.',
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
      const args = (raw ?? {}) as { query?: unknown; market?: unknown; type?: unknown; limit?: unknown }
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      if (!query) {
        throw new Error('instruments_search: query is required')
      }
      const typeFilter: InstrumentForm | undefined = args.type === 'spot' || args.type === 'perp' ? args.type : undefined
      const markets: readonly CatalogMarket[] = isSearchMarket(args.market) ? [args.market] : [...MARKETS]
      const perMarketCap = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.trunc(args.limit), 20)
        : 10

      const results: SearchCandidate[] = []
      let matched = 0
      for (const market of markets) {
        const seen = new Set<string>()
        const ranked: RankedCandidate[] = []
        const collect = (
          symbol: string,
          name: string | undefined,
          form: InstrumentForm,
          assetClass: InstrumentAssetClass | undefined,
          source: 'dynamic' | 'catalog',
        ): void => {
          const upper = symbol.toUpperCase()
          if (seen.has(upper)) return
          if (typeFilter !== undefined && form !== typeFilter) return
          const symbolHay = upper.toLowerCase()
          const nameHay = (name ?? '').toLowerCase()
          let tier: MatchTier
          if (symbolHay.startsWith(query)) tier = 0
          else if (symbolHay.includes(query)) tier = 1
          else if (nameHay.includes(query)) tier = 2
          else return
          seen.add(upper)
          ranked.push({
            market,
            symbol,
            ...(name ? { name } : {}),
            form,
            ...(assetClass ? { assetClass } : {}),
            source,
            exact: symbolHay === query,
            tier,
            seq: ranked.length,
          })
        }

        // 1. 动态全集（listInstruments 可选能力，失败静默跳过）
        const active = services.registry?.active(market)
        if (active !== undefined && typeof active.service.listInstruments === 'function') {
          try {
            const list = await active.service.listInstruments()
            for (const item of list ?? []) {
              const symbol = String(item.symbol ?? '')
              if (!symbol) continue
              collect(symbol, item.name, item.form ?? instrumentFormOf(symbol), item.assetClass, 'dynamic')
            }
          } catch {
            /* 动态全集失败 → 静态字典兜底 */
          }
        }
        // 2. 静态字典兜底（host SSOT）
        for (const entry of SYMBOL_CATALOG[market] ?? []) {
          collect(entry.symbol, entry.name, entry.form ?? instrumentFormOf(entry.symbol), entry.assetClass, 'catalog')
        }
        // 3. exact → crypto 资产类别 → 匹配档位 → 收集顺序；截断时保形态覆盖。
        // 资产标签先于文本档位：TradFi 符号与查询的巧合前缀（US500/SKHYNIX…）此前会把
        // crypto 结果整片挤到 limit 之外，而「避免 500 个 swap 截断掉现货」正是本卡的排序目的。
        ranked.sort((a, b) => (Number(b.exact) - Number(a.exact))
          || (assetClassRank(a.assetClass) - assetClassRank(b.assetClass))
          || (a.tier - b.tier)
          || (a.seq - b.seq))
        matched += ranked.length
        results.push(...coverForms(ranked, perMarketCap))
      }
      return JSON.stringify({ ok: true, query, total: results.length, matched, results })
    },
  })
}
