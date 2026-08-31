/**
 * Trading settings controller: a SnapshotStore over the dshtrading namespace
 * view (markets map + provider presence), with the write methods supplied as
 * plain inject fields (官方模式: hooks = 可观察状态, 普通字段 = 写操作)。
 * The Host (dsh-trading/router) owns the namespace and its schema; this
 * controller binds the client settings scope and translates user choices
 * into revision-fenced path mutations.
 */
import type {
  SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'

export interface ProviderMeta {
  id: string
  label: string
  url?: string
  env?: string
  type: 'public' | 'commercial' | 'gateway'
}

/** provider 候选显示名与指引（slug + 显示名 + 官网/API Key 申请链接 + 环境变量；值与 router PROVIDER_VOCABULARY 对齐）。 */
export const PROVIDER_LABELS: readonly Readonly<ProviderMeta>[] = [
  { id: 'binance', label: 'Binance (币安)', url: 'https://binance.com/en/binance-api', env: 'BINANCE_API_KEY', type: 'public' },
  { id: 'okx', label: 'OKX (欧易)', url: 'https://okx.com/docs-v5/zh/', env: 'OKX_API_KEY', type: 'public' },
  { id: 'bybit', label: 'Bybit', url: 'https://bybit.com/en/api-overview', env: 'BYBIT_API_KEY', type: 'public' },
  { id: 'ccxt', label: 'CCXT (跨所聚合 100+)', url: 'https://ccxt.com', env: 'CCXT_API_KEY', type: 'public' },
  { id: 'yahoo', label: 'Yahoo Finance', url: 'https://finance.yahoo.com', type: 'public' },
  { id: 'alpaca', label: 'Alpaca', url: 'https://alpaca.markets', env: 'ALPACA_API_KEY', type: 'commercial' },
  { id: 'fmp', label: 'FMP (Financial Modeling Prep)', url: 'https://site.financialmodelingprep.com/developer', env: 'FMP_API_KEY', type: 'commercial' },
  { id: 'finnhub', label: 'Finnhub', url: 'https://finnhub.io/register', env: 'FINNHUB_API_KEY', type: 'commercial' },
  { id: 'polygon', label: 'Polygon.io (Massive)', url: 'https://polygon.io', env: 'POLYGON_API_KEY', type: 'commercial' },
  { id: 'ibkr', label: 'IBKR (盈透证券)', url: 'https://interactivebrokers.com/campus/ibkr-api-page/cpapi/', env: 'IBKR_GATEWAY_URL', type: 'gateway' },
  { id: 'stooq', label: 'Stooq', url: 'https://stooq.com', type: 'public' },
  { id: 'tencent', label: '腾讯 (Tencent)', url: 'https://finance.qq.com', type: 'public' },
  { id: 'eastmoney', label: '东方财富 (Eastmoney)', url: 'https://eastmoney.com', type: 'public' },
  { id: 'tushare', label: 'Tushare Pro', url: 'https://tushare.pro/register', env: 'TUSHARE_TOKEN', type: 'commercial' },
  { id: 'akshare', label: 'AkShare (宏观/另类量化)', url: 'https://akshare.xyz', env: 'AKSHARE_API_URL', type: 'public' },
  { id: 'qmt', label: 'MiniQMT (迅投券商实盘)', url: 'http://127.0.0.1:5800', env: 'QMT_GATEWAY_URL', type: 'gateway' },
  { id: 'futu', label: 'Futu (富途 OpenD)', url: 'https://futunn.com/download/open-api', env: 'FUTU_HOST', type: 'gateway' },
  { id: 'longbridge', label: 'Longbridge (长桥)', url: 'https://open.longportapp.com', env: 'LONGBRIDGE_APP_KEY', type: 'commercial' },
  { id: 'tiger', label: 'Tiger Trade (老虎证券)', url: 'https://developer.itigerup.com', env: 'TIGER_ID', type: 'commercial' },
]

/** dshtrading namespace 下的值形状（router 侧同步；窄化后的子集契约）。 */
export interface TradingSettings {
  markets: Record<string, { provider?: string; tradeProvider?: string }>
  /** WS2c：新闻相关设置（CryptoPanic API token，可选）。 */
  news?: { cryptoPanicKey?: string }
}

/** 组件的可观察状态（SnapshotStore 值）：已解析 value + 覆盖标记。 */
export interface TradingSettingsState {
  status: 'loading' | 'ready' | 'unavailable'
  /** market id → 已解析 provider（undefined = 未解析到）。 */
  resolved: Record<string, string | undefined>
  /** market id → 用户是否覆盖（user 层 presence）。 */
  overridden: Record<string, boolean>
  /** WS2c：已解析 CryptoPanic key（undefined = 无 key = 新闻走公共源）。 */
  newsKey: string | undefined
  /** WS2c：用户是否覆盖了 CryptoPanic key。 */
  newsOverridden: boolean
  /** 表单可写（mode=host 且 writable）。 */
  writable: boolean
}

/** 写路径（普通 inject 字段）。 */
export interface TradingSettingsActions {
  setProvider(market: string, provider: string): Promise<void>
  resetProvider(market: string): Promise<void>
  /** WS2c：设置/清除 CryptoPanic key（空串 = 清除回公共源）。 */
  setNewsKey(value: string): Promise<void>
  resetNewsKey(): Promise<void>
}

/** 状态转化：从 settings 快照投射为组件的可观察视图。 */
export function projectSnapshot(snap: SettingsScopeSnapshot<TradingSettings>): TradingSettingsState {
  const value = snap.value ?? (snap.base as TradingSettings | undefined)
  const user = (snap.user ?? {}) as { markets?: Record<string, unknown> }
  // 市场键 = value/base/user 的实际键并集（dict 开放：新市场的键出现即进入，无需改码）。
  const marketIds = new Set<string>([
    ...Object.keys(value?.markets ?? {}),
    ...Object.keys((snap.base as TradingSettings | undefined)?.markets ?? {}),
    ...Object.keys(user.markets ?? {}),
  ])
  const resolved: Record<string, string | undefined> = {}
  const overridden: Record<string, boolean> = {}
  const baseMarkets = (snap.base as TradingSettings | undefined)?.markets ?? {}
  for (const marketId of marketIds) {
    // 逐市场 value 优先、base 兜底：value 缺该市场键时（部分合并）仍能解析到实际 provider。
    resolved[marketId] = value?.markets?.[marketId]?.provider ?? baseMarkets[marketId]?.provider
    overridden[marketId] = user.markets?.[marketId] !== undefined
  }
  // WS2c：新闻 key 同理（value 优先、base 兜底；user 层 presence 判 overridden）。
  const baseNews = (snap.base as TradingSettings | undefined)?.news
  const news = value?.news ?? baseNews
  const userNews = ((snap.user ?? {}) as { news?: { cryptoPanicKey?: string } }).news
  return {
    status: snap.status,
    resolved,
    overridden,
    newsKey: news?.cryptoPanicKey,
    newsOverridden: userNews?.cryptoPanicKey !== undefined,
    writable: snap.writable && snap.mode === 'host',
  }
}

/** 从 settings scope 构建 SnapshotStore（getSnapshot 稳定引用 + subscribe 转发）。 */
export function createTradingSettingsStore(scope: SettingsScope<TradingSettings>): SnapshotStore<TradingSettingsState> {
  let cached: TradingSettingsState = projectSnapshot(scope.getSnapshot())
  return {
    getSnapshot: () => {
      const current = projectSnapshot(scope.getSnapshot())
      // 引用稳定：值未变则复用缓存（bindSnapshotSelector 依赖引用稳定性做浅比较）。
      if (JSON.stringify(current) !== JSON.stringify(cached)) cached = current
      return cached
    },
    subscribe: (listener) => scope.subscribe(listener),
  }
}
