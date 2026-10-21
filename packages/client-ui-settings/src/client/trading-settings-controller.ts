/**
 * Trading settings controller: a SnapshotStore over the dshtrading namespace
 * view (markets map + provider presence), with the write methods supplied as
 * plain inject fields (官方模式: hooks = 可观察状态, 普通字段 = 写操作)。
 * The Host (dsh-trading/router) owns the namespace and its schema; this
 * controller binds the client settings scope and translates user choices
 * into revision-fenced path mutations.
 */
import type {
  ConfigForm,
  ConfigFormSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'

export interface ProviderMeta {
  id: string
  /** 显示名词典键（dshtrading.settings，渲染处 t() 解析）。 */
  label: string
  url?: string
  /**
   * 环境变量名，**只有这一种语义**：连接器在自己的读取路径里真回落到的 BYOK 环境变量名。
   * 连接器没有这个 env 读取点就不写——提示写出来就是一句实现不了的承诺。
   */
  env?: string
  /**
   * 连接器 Config 的字段名，**只有这一种语义**：非密端点/账户标识的家在连接器自己的
   * Config schema（schema 默认值 + 接线行 + 官方插件配置表单），不在设置页凭据卡片里。
   */
  configField?: string
  type: 'public' | 'commercial' | 'gateway'
  markets: readonly string[]
}

/**
 * provider 候选显示名与指引（词典键 + 官网/API Key 申请链接 + 环境变量或 Config 字段名 +
 * 支持市场；值与 router PROVIDER_VOCABULARY 对齐）。
 *
 * `env` / `configField` 的取值判据 = 连接器源码里的真读取点（不是平台能力，也不是申请
 * 链接上的名字）：binance/ccxt 全包没有任何 `BINANCE_API_KEY` / `CCXT_API_KEY` 读取点，
 * 故无提示；ibkr/qmt/xysz/futu 的地址在插件路径上由各自 Config 字段决定（rest 层的同名
 * 环境变量被 schema 默认值遮蔽），故提示写 Config 字段名而不是环境变量名。
 */
export const PROVIDER_LABELS: readonly Readonly<ProviderMeta>[] = [
  { id: 'binance', label: 'provider.binance', url: 'https://binance.com/en/binance-api', type: 'public', markets: ['crypto'] },
  { id: 'okx', label: 'provider.okx', url: 'https://okx.com/docs-v5/zh/', env: 'OKX_API_KEY', type: 'public', markets: ['crypto'] },
  { id: 'bybit', label: 'provider.bybit', url: 'https://bybit.com/en/api-overview', env: 'BYBIT_API_KEY', type: 'public', markets: ['crypto'] },
  { id: 'ccxt', label: 'provider.ccxt', url: 'https://ccxt.com', type: 'public', markets: ['crypto'] },
  { id: 'yahoo', label: 'provider.yahoo', url: 'https://finance.yahoo.com', type: 'public', markets: ['us', 'hk'] },
  { id: 'alpaca', label: 'provider.alpaca', url: 'https://alpaca.markets', env: 'ALPACA_API_KEY', type: 'commercial', markets: ['us'] },
  { id: 'fmp', label: 'provider.fmp', url: 'https://site.financialmodelingprep.com/developer', env: 'FMP_API_KEY', type: 'commercial', markets: ['us'] },
  { id: 'finnhub', label: 'provider.finnhub', url: 'https://finnhub.io/register', env: 'FINNHUB_API_KEY', type: 'commercial', markets: ['us'] },
  { id: 'polygon', label: 'provider.polygon', url: 'https://polygon.io', env: 'POLYGON_API_KEY', type: 'commercial', markets: ['us'] },
  { id: 'ibkr', label: 'provider.ibkr', url: 'https://interactivebrokers.com/campus/ibkr-api-page/cpapi/', configField: 'gatewayUrl', type: 'gateway', markets: ['us'] },
  { id: 'stooq', label: 'provider.stooq', url: 'https://stooq.com', type: 'public', markets: ['us'] },
  { id: 'tencent', label: 'provider.tencent', url: 'https://finance.qq.com', type: 'public', markets: ['cn', 'hk'] },
  { id: 'eastmoney', label: 'provider.eastmoney', url: 'https://eastmoney.com', type: 'public', markets: ['cn', 'hk'] },
  // markets 判据 = 连接器 dataplane 的真实注册面，不是券商平台能力：tushare 仅 A 股（cn）、
  // ibkr 仅 us、akshare 仅 cn、tiger 仅 hk（各注册一个市场）；futu 行情面 hk+us（EXTRA_QUOTE_MARKETS），交易面仍仅 hk。
  { id: 'tushare', label: 'provider.tushare', url: 'https://tushare.pro/register', env: 'TUSHARE_TOKEN', type: 'commercial', markets: ['cn'] },
  // akshare 实现面是东方财富公开端点：无本地服务、无凭证，故不标 env，也不挂凭据字段。
  { id: 'akshare', label: 'provider.akshare', url: 'https://akshare.xyz', type: 'public', markets: ['cn'] },
  // qmt/ibkr 的网关地址与 xysz 的服务地址：家在各自连接器 Config（schema 默认值随接线行落地）；
  // rest 层的同名环境变量（QMT_GATEWAY_URL / IBKR_GATEWAY_URL / XYSZ_API_URL）在插件路径上
  // 被 Config 默认值遮蔽，插件路径不读它们。
  { id: 'qmt', label: 'provider.qmt', url: 'http://127.0.0.1:5800', configField: 'gatewayUrl', type: 'gateway', markets: ['cn'] },
  // futu 的 OpenD 地址家在连接器 Config 的 gatewayUrl 一格（面板原来的 host/port 无人读，
  // 见 src/client/trading-settings-controller.ts 的凭据面规则与 connector-futu README「已知边界」）。
  { id: 'futu', label: 'provider.futu', url: 'https://futunn.com/download/open-api', configField: 'gatewayUrl', type: 'gateway', markets: ['hk', 'us'] },
  { id: 'longbridge', label: 'provider.longbridge', url: 'https://open.longportapp.com', env: 'LONGBRIDGE_APP_KEY', type: 'commercial', markets: ['hk', 'us'] },
  { id: 'tiger', label: 'provider.tiger', url: 'https://developer.itigerup.com', env: 'TIGER_ID', type: 'commercial', markets: ['hk'] },
  { id: 'jin10', label: 'provider.jin10', url: 'https://mcp.jin10.com', env: 'JIN10_MCP_TOKEN', type: 'public', markets: ['global'] },
  { id: 'hithink', label: 'provider.hithink', url: 'https://fuyao.aicubes.cn', env: 'HITHINK_FINANCE_API_KEY', type: 'commercial', markets: ['cn', 'futures'] },
  { id: 'xysz', label: 'provider.xysz', url: 'https://www.chinastock.com.cn', configField: 'apiUrl', type: 'commercial', markets: ['cn'] },
]

/** 新闻/公告源候选（issue #96 源配置化）：id = 各 kit NewsSource 词汇；label = 词典键。 */
export interface NewsSourceMeta {
  id: string
  label: string
}

export const NEWS_SOURCE_CATALOG: Record<string, readonly NewsSourceMeta[]> = {
  cn: [
    { id: 'eastmoney', label: 'newsSource.eastmoney' },
    { id: 'eastmoney-announcement', label: 'newsSource.eastmoneyAnnouncement' },
    { id: 'cninfo-announcement', label: 'newsSource.cninfoAnnouncement' },
    { id: 'eastmoney-fund-announcement', label: 'newsSource.eastmoneyFundAnnouncement' },
  ],
  us: [
    { id: 'yahoo', label: 'newsSource.yahoo' },
    { id: 'googlenews', label: 'newsSource.googlenews' },
    { id: 'sec-edgar', label: 'newsSource.secEdgar' },
  ],
  hk: [
    { id: 'eastmoney', label: 'newsSource.eastmoney' },
    { id: 'eastmoney-announcement', label: 'newsSource.eastmoneyAnnouncement' },
    { id: 'hkex-announcement', label: 'newsSource.hkexAnnouncement' },
  ],
  crypto: [
    { id: 'binance', label: 'newsSource.binance' },
    { id: 'okx', label: 'newsSource.okx' },
    { id: 'coindesk', label: 'newsSource.coindesk' },
    { id: 'theblock', label: 'newsSource.theblock' },
    { id: 'cointelegraph', label: 'newsSource.cointelegraph' },
    { id: 'decrypt', label: 'newsSource.decrypt' },
    { id: 'cryptopanic', label: 'newsSource.cryptopanic' },
  ],
}

export interface CredentialField {
  key: string
  /** 字段显示名词典键（dshtrading.settings，渲染处 t() 解析）。 */
  label: string
  /** 输入框占位词典键（可缺省；渲染处 t() 解析）。 */
  placeholder?: string
  secret?: boolean
}

/**
 * 凭据卡片的字段规格：**密文字段 × 真出站消费点**两条同时成立，才挂在面板上。
 *
 * - 密文字段：值的家是 `dshtrading.credentials.<provider>`（router `getCredential`）。
 *   设置页写的就是这个字典，卡片自带脱敏显示与「已配置/未配置」状态，只适合密钥类值。
 * - 真出站消费点：连接器代码真读这个键，且值能进到请求里（签名 / 认证头 / 查询串）。
 *
 * 任一条不成立即撤字段（2026-10-15 收窄；对照表与证据见
 * .agents/notes/implemented/simplification/2026-10-15-settings-credential-surface-narrowed.md）：
 *
 * - binance / ccxt / bybit：连接器没有「把 credentials.<provider> 取出来用」的路径。
 *   binance 与 ccxt 连凭证取值点都不存在（ccxt 的 `CcxtRestOptions.apiKey/secret` 只被赋值、
 *   从不进请求）；bybit 只从 env 取值，且没有签名出站路径（rest 的 placeOrder 收 `_creds`
 *   却忽略）。值进不了任何请求的密钥字段 = 让用户以为配好了的纯承诺。
 * - qmt / ibkr（gatewayUrl）与 futu（host/port）：非密端点地址，家在连接器 Config
 *   （见 PROVIDER_LABELS 的 `configField`）；面板原字段写进的是另一处无人读的命名空间。
 * - tiger 的 tigerId：非密账户标识，家在连接器 Config（`tigerId`，rest 层另有 `TIGER_ID` 回落）。
 *
 * 反向补齐（同批）：longbridge 三字段与 tiger 的 privateKey 本来只有 env 取值点，现按
 * fmp/finnhub/polygon 既有体例补上 `getCredential('<provider>')` 读取点（settings 优先、
 * env 兜底），值分别进 longbridge 的 HMAC-SHA256 签名与 tiger 的 RSA2 签名。
 */
export const PROVIDER_CREDENTIAL_SPECS: Record<string, readonly CredentialField[]> = {
  okx: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'field.placeholder.okxKey', secret: true },
    { key: 'secretKey', label: 'field.label.secretKey', placeholder: 'field.placeholder.okxSecret', secret: true },
    { key: 'passphrase', label: 'field.label.passphrase', placeholder: 'field.placeholder.okxPassphrase', secret: true },
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
  longbridge: [
    { key: 'appKey', label: 'field.label.appKey', placeholder: 'field.placeholder.longbridgeAppKey', secret: true },
    { key: 'appSecret', label: 'field.label.appSecret', placeholder: 'field.placeholder.longbridgeAppSecret', secret: true },
    { key: 'accessToken', label: 'field.label.accessToken', placeholder: 'field.placeholder.longbridgeAccessToken', secret: true },
  ],
  tiger: [
    { key: 'privateKey', label: 'field.label.tigerPrivateKey', placeholder: 'field.placeholder.tigerPrivateKey', secret: true },
  ],
  jin10: [
    // 金十 MCP 用 Bearer token（凭据落 dshtrading.credentials.jin10.token，与
    // settings 面板的「市场快讯数据源」卡片同键；逐请求惰性解析）。
    { key: 'token', label: 'field.label.mcpToken', placeholder: 'JIN10_MCP_TOKEN', secret: true },
  ],
  hithink: [
    { key: 'apiKey', label: 'field.label.apiKey', placeholder: 'HITHINK_FINANCE_API_KEY', secret: true },
  ],
}

/** dshtrading namespace 下的值形状（router 侧同步；窄化后的子集契约）。 */
export interface TradingSettings {
  markets: Record<string, { provider?: string; tradeProvider?: string }>
  /** 各提供方 API 凭证。 */
  credentials?: Record<string, Record<string, string>>
  /** WS2c：新闻相关设置（CryptoPanic API token + 每市场启用源，可选）。 */
  news?: { cryptoPanicKey?: string; sources?: Record<string, string[]> }
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
  /** issue #96：market id → 已解析启用源列表（undefined = 未配置 = kit 默认源全集）。 */
  newsSources: Record<string, readonly string[] | undefined>
  /** issue #96：market id → 用户是否覆盖了启用源。 */
  newsSourcesOverridden: Record<string, boolean>
  /** 涨跌配色模式。 */
  colorMode: 'red-up' | 'green-up'
  /** 表单可写：直接取快照的 writable（Host 文档是否接受写入）。 */
  writable: boolean
}

/** 写路径（普通 inject 字段）。 */
export interface TradingSettingsActions {
  setProvider(market: string, provider: string): Promise<void>
  resetProvider(market: string): Promise<void>
  setCredential(provider: string, fields: Record<string, string>): Promise<void>
  deleteCredential(provider: string): Promise<void>
  /** 设置/清除金十 MCP Token（空串 = 清除；凭证落 dshtrading.credentials.jin10.token）。 */
  setJin10Token(value: string): Promise<void>
  /** 清除金十 MCP Token（回未配置态）。 */
  clearJin10Token(): Promise<void>
  /** WS2c：设置/清除 CryptoPanic key（空串 = 清除回公共源）。 */
  setNewsKey(value: string): Promise<void>
  resetNewsKey(): Promise<void>
  /** issue #96：设置/清除某市场启用的新闻源列表（ids = 全量勾选集合；reset = 回 kit 默认源）。 */
  setNewsSources(market: string, ids: readonly string[]): Promise<void>
  resetNewsSources(market: string): Promise<void>
  /** 设置涨跌配色模式。 */
  setColorMode(mode: 'red-up' | 'green-up'): Promise<void>
}

/** 状态转化：从 settings 快照投射为组件的可观察视图。 */
export function projectSnapshot(snap: ConfigFormSnapshot<TradingSettings>): TradingSettingsState {
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
  const userNews = ((snap.user ?? {}) as { news?: { cryptoPanicKey?: string; sources?: Record<string, unknown> } }).news
  // issue #96：每市场启用源（value 优先、base 兜底；user 层 presence 判 overridden）。
  const newsSources: Record<string, readonly string[] | undefined> = {}
  const newsSourcesOverridden: Record<string, boolean> = {}
  const sourceMarketIds = new Set<string>([
    ...Object.keys(news?.sources ?? {}),
    ...Object.keys(userNews?.sources ?? {}),
  ])
  for (const marketId of sourceMarketIds) {
    newsSources[marketId] = news?.sources?.[marketId]
    newsSourcesOverridden[marketId] = userNews?.sources?.[marketId] !== undefined
  }
  return {
    status: snap.status,
    resolved,
    overridden,
    credentials,
    newsKey: news?.cryptoPanicKey,
    newsOverridden: userNews?.cryptoPanicKey !== undefined,
    newsSources,
    newsSourcesOverridden,
    colorMode: value?.colorMode === 'green-up' ? 'green-up' : 'red-up',
    writable: snap.writable,
  }
}

/** 面板消费的最小可观察面（getSnapshot 稳定引用 + subscribe 转发）。
 *  0.1.7：dsh-client-store 的 SnapshotStore 已扩含 update/set，本 shim 只读，
 *  不再对外声明完整 SnapshotStore（避免补桩一堆用不到的写方法）。 */
export interface TradingSettingsStore {
  getSnapshot: () => TradingSettingsState
  subscribe: (listener: () => void) => () => void
}

/** 从 configForms 的 dshtrading 表单构建只读快照源（稳定引用 + subscribe 转发）。 */
export function createTradingSettingsStore(form: ConfigForm<TradingSettings>): TradingSettingsStore {
  let cached: TradingSettingsState = projectSnapshot(form.getSnapshot())
  return {
    getSnapshot: () => {
      const current = projectSnapshot(form.getSnapshot())
      // 引用稳定：值未变则复用缓存（bindSnapshotSelector 依赖引用稳定性做浅比较）。
      if (JSON.stringify(current) !== JSON.stringify(cached)) cached = current
      return cached
    },
    subscribe: (listener) => form.subscribe(listener),
  }
}

/**
 * 0.1.7 写路径的接受语义：ConfigForm.mutate 对 Host 拒绝（settings/rejected /
 * settings/conflict / 该 namespace 未挂、只读）resolve `false` 而不是 reject，
 * 只有传输层故障才抛。直接 await 会把「被拒绝」误当成功——设置页显示「已保存」
 * 而 profile 文档未变（2026-09-24 桌面端实证）。本函数把 false 转成显式错误，
 * 由面板 catch 后如实显示保存失败。
 * @param accepted - mutate 的布尔结果。
 * @param entryId - 设置面 entry id（行 id），进错误消息便于定位。
 * @returns 接受时正常返回；被拒绝时抛错。
 */
export async function requireAccepted(accepted: Promise<boolean> | boolean, entryId: string): Promise<void> {
  if (!(await accepted)) {
    throw new Error(`settings write rejected for "${entryId}" (not served, read-only, or stale revision)`)
  }
}
