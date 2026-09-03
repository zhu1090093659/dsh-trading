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
  /** 显示名词典键（dshtrading.settings，渲染处 t() 解析）。 */
  label: string
  url?: string
  env?: string
  type: 'public' | 'commercial' | 'gateway'
  markets: readonly string[]
}

/** provider 候选显示名与指引（词典键 + 官网/API Key 申请链接 + 环境变量 + 支持市场；值与 router PROVIDER_VOCABULARY 对齐）。 */
export const PROVIDER_LABELS: readonly Readonly<ProviderMeta>[] = [
  { id: 'binance', label: 'provider.binance', url: 'https://binance.com/en/binance-api', env: 'BINANCE_API_KEY', type: 'public', markets: ['crypto'] },
  { id: 'okx', label: 'provider.okx', url: 'https://okx.com/docs-v5/zh/', env: 'OKX_API_KEY', type: 'public', markets: ['crypto'] },
  { id: 'bybit', label: 'provider.bybit', url: 'https://bybit.com/en/api-overview', env: 'BYBIT_API_KEY', type: 'public', markets: ['crypto'] },
  { id: 'ccxt', label: 'provider.ccxt', url: 'https://ccxt.com', env: 'CCXT_API_KEY', type: 'public', markets: ['crypto'] },
  { id: 'yahoo', label: 'provider.yahoo', url: 'https://finance.yahoo.com', type: 'public', markets: ['us', 'hk'] },
  { id: 'alpaca', label: 'provider.alpaca', url: 'https://alpaca.markets', env: 'ALPACA_API_KEY', type: 'commercial', markets: ['us'] },
  { id: 'fmp', label: 'provider.fmp', url: 'https://site.financialmodelingprep.com/developer', env: 'FMP_API_KEY', type: 'commercial', markets: ['us'] },
  { id: 'finnhub', label: 'provider.finnhub', url: 'https://finnhub.io/register', env: 'FINNHUB_API_KEY', type: 'commercial', markets: ['us'] },
  { id: 'polygon', label: 'provider.polygon', url: 'https://polygon.io', env: 'POLYGON_API_KEY', type: 'commercial', markets: ['us'] },
  { id: 'ibkr', label: 'provider.ibkr', url: 'https://interactivebrokers.com/campus/ibkr-api-page/cpapi/', env: 'IBKR_GATEWAY_URL', type: 'gateway', markets: ['us', 'hk'] },
  { id: 'stooq', label: 'provider.stooq', url: 'https://stooq.com', type: 'public', markets: ['us'] },
  { id: 'tencent', label: 'provider.tencent', url: 'https://finance.qq.com', type: 'public', markets: ['cn', 'hk'] },
  { id: 'eastmoney', label: 'provider.eastmoney', url: 'https://eastmoney.com', type: 'public', markets: ['cn', 'hk'] },
  { id: 'tushare', label: 'provider.tushare', url: 'https://tushare.pro/register', env: 'TUSHARE_TOKEN', type: 'commercial', markets: ['cn', 'hk', 'us'] },
  { id: 'akshare', label: 'provider.akshare', url: 'https://akshare.xyz', env: 'AKSHARE_API_URL', type: 'public', markets: ['cn', 'hk'] },
  { id: 'qmt', label: 'provider.qmt', url: 'http://127.0.0.1:5800', env: 'QMT_GATEWAY_URL', type: 'gateway', markets: ['cn'] },
  { id: 'futu', label: 'provider.futu', url: 'https://futunn.com/download/open-api', env: 'FUTU_HOST', type: 'gateway', markets: ['hk', 'us', 'cn'] },
  { id: 'longbridge', label: 'provider.longbridge', url: 'https://open.longportapp.com', env: 'LONGBRIDGE_APP_KEY', type: 'commercial', markets: ['hk', 'us'] },
  { id: 'tiger', label: 'provider.tiger', url: 'https://developer.itigerup.com', env: 'TIGER_ID', type: 'commercial', markets: ['hk', 'us', 'cn'] },
]

export interface CredentialField {
  key: string
  /** 字段显示名词典键（dshtrading.settings，渲染处 t() 解析）。 */
  label: string
  /** 输入框占位词典键（可缺省；渲染处 t() 解析）。 */
  placeholder?: string
  secret?: boolean
}

export const PROVIDER_CREDENTIAL_SPECS: Record<string, readonly CredentialField[]> = {
  binance: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'field.placeholder.binanceKey', secret: true },
    { key: 'apiSecret', label: 'field.label.apiSecret', placeholder: 'field.placeholder.binanceSecret', secret: true },
  ],
  okx: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'field.placeholder.okxKey', secret: true },
    { key: 'secretKey', label: 'field.label.secretKey', placeholder: 'field.placeholder.okxSecret', secret: true },
    { key: 'passphrase', label: 'field.label.passphrase', placeholder: 'field.placeholder.okxPassphrase', secret: true },
  ],
  bybit: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'field.placeholder.bybitKey', secret: true },
    { key: 'apiSecret', label: 'field.label.apiSecret', placeholder: 'field.placeholder.bybitSecret', secret: true },
  ],
  ccxt: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'field.placeholder.ccxtKey', secret: true },
    { key: 'apiSecret', label: 'field.label.apiSecret', placeholder: 'field.placeholder.ccxtSecret', secret: true },
  ],
  alpaca: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'field.placeholder.alpacaKey', secret: true },
    { key: 'secretKey', label: 'field.label.secretKey', placeholder: 'field.placeholder.alpacaSecret', secret: true },
  ],
  fmp: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'field.placeholder.fmpKey', secret: true },
  ],
  finnhub: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'field.placeholder.finnhubKey', secret: true },
  ],
  polygon: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'field.placeholder.polygonKey', secret: true },
  ],
  tushare: [
    { key: 'token', label: 'field.label.token', placeholder: 'field.placeholder.tushareToken', secret: true },
  ],
  akshare: [
    { key: 'apiUrl', label: 'field.label.apiUrl', placeholder: 'field.placeholder.akshareUrl' },
  ],
  qmt: [
    { key: 'gatewayUrl', label: 'field.label.qmtUrl', placeholder: 'field.placeholder.qmtUrl' },
  ],
  futu: [
    { key: 'host', label: 'field.label.futuHost', placeholder: 'field.placeholder.futuHost' },
    { key: 'port', label: 'field.label.futuPort', placeholder: 'field.placeholder.futuPort' },
  ],
  ibkr: [
    { key: 'gatewayUrl', label: 'field.label.ibkrUrl', placeholder: 'field.placeholder.ibkrUrl' },
  ],
  longbridge: [
    { key: 'appKey', label: 'field.label.appKey', placeholder: 'field.placeholder.longbridgeAppKey', secret: true },
    { key: 'appSecret', label: 'field.label.appSecret', placeholder: 'field.placeholder.longbridgeAppSecret', secret: true },
    { key: 'accessToken', label: 'field.label.accessToken', placeholder: 'field.placeholder.longbridgeAccessToken', secret: true },
  ],
  tiger: [
    { key: 'tigerId', label: 'field.label.tigerId', placeholder: 'field.placeholder.tigerId' },
    { key: 'privateKey', label: 'field.label.tigerPrivateKey', placeholder: 'field.placeholder.tigerPrivateKey', secret: true },
  ],
}

/** dshtrading namespace 下的值形状（router 侧同步；窄化后的子集契约）。 */
export interface TradingSettings {
  markets: Record<string, { provider?: string; tradeProvider?: string }>
  /** 各提供方 API 凭证。 */
  credentials?: Record<string, Record<string, string>>
  /** WS2c：新闻相关设置（CryptoPanic API token，可选）。 */
  news?: { cryptoPanicKey?: string }
  /** 涨跌配色模式：red-up = 红涨绿跌（国内），green-up = 绿涨红跌（国际）。 */
  colorMode?: 'red-up' | 'green-up'
}

/** 组件的可观察状态（SnapshotStore 值）：已解析 value + 覆盖标记。 */
export interface TradingSettingsState {
  status: 'loading' | 'ready' | 'unavailable'
  /** market id → 已解析 provider（undefined = 未解析到）。 */
  resolved: Record<string, string | undefined>
  /** market id → 用户是否覆盖（user 层 presence）。 */
  overridden: Record<string, boolean>
  /** provider id → credentials 字典。 */
  credentials: Record<string, Record<string, string>>
  /** WS2c：已解析 CryptoPanic key（undefined = 无 key = 新闻走公共源）。 */
  newsKey: string | undefined
  /** WS2c：用户是否覆盖了 CryptoPanic key。 */
  newsOverridden: boolean
  /** 涨跌配色模式。 */
  colorMode: 'red-up' | 'green-up'
  /** 表单可写（mode=host 且 writable）。 */
  writable: boolean
}

/** 写路径（普通 inject 字段）。 */
export interface TradingSettingsActions {
  setProvider(market: string, provider: string): Promise<void>
  resetProvider(market: string): Promise<void>
  setCredential(provider: string, fields: Record<string, string>): Promise<void>
  deleteCredential(provider: string): Promise<void>
  /** WS2c：设置/清除 CryptoPanic key（空串 = 清除回公共源）。 */
  setNewsKey(value: string): Promise<void>
  resetNewsKey(): Promise<void>
  /** 设置涨跌配色模式。 */
  setColorMode(mode: 'red-up' | 'green-up'): Promise<void>
}

/** 状态转化：从 settings 快照投射为组件的可观察视图。 */
export function projectSnapshot(snap: SettingsScopeSnapshot<TradingSettings>): TradingSettingsState {
  const value = snap.value ?? (snap.base as TradingSettings | undefined)
  const user = (snap.user ?? {}) as { markets?: Record<string, unknown>; credentials?: Record<string, unknown> }
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

  // 凭证字典
  const credentials = value?.credentials ?? {}

  // WS2c：新闻 key 同理（value 优先、base 兜底；user 层 presence 判 overridden）。
  const baseNews = (snap.base as TradingSettings | undefined)?.news
  const news = value?.news ?? baseNews
  const userNews = ((snap.user ?? {}) as { news?: { cryptoPanicKey?: string } }).news
  return {
    status: snap.status,
    resolved,
    overridden,
    credentials,
    newsKey: news?.cryptoPanicKey,
    newsOverridden: userNews?.cryptoPanicKey !== undefined,
    colorMode: value?.colorMode === 'green-up' ? 'green-up' : 'red-up',
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
