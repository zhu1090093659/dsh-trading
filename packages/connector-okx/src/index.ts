/**
 * OKX 连接器插件（dsh-trading okx 切片 R1-R3）：真实 MarketDataService + crypto 市场
 * 第一个真实 TradeService。
 *
 * 与 connector-binance 的关系（主 agent 裁决 2026-08-29，方案 B+C）：
 * - **互斥激活**：Config.enabled（默认 false）。false 时整个 apply() 静默退出——不
 *   provide 服务、不注册任何工具，`tradingCryptoMarketData` 与同名 `crypto_*` 工具
 *   归 connector-binance（binance 不动）；true 时由本插件独占。两连接器并存于同一
 *   组合时必须恰好激活一个。为防御误配置，工具注册走 duplicate-safe 路径：名字已被
 *   占用时跳过并 log（dsh-tools 对重复名直接抛错会炸 boot）。
 * - **交易服务分离**：okx 额外 provide `tradingCryptoTrade`（api 包 TradeService 的
 *   第一个真实实现；类型增强声明在 @dsh-trading/api）。
 *
 * 三态环境语义（主 agent 裁决，映射铁律 #3 三段闸门）：
 * - dryRun=true（缺省）→ 本地模拟回执，不发任何请求；
 * - dryRun=false + liveTrading=false → 结构化拒绝（headless 唯一防线）；
 * - dryRun=false + liveTrading=true + env='demo'（缺省）→ 真实签名下单 +
 *   `x-simulated-trading: 1`，成交在 OKX 模拟盘（liveTrading=true 的第一默认目标
 *   是 demo 而非真钱）；
 * - env='live' → 真实实盘（无模拟盘头；base 统一审批闸门照旧 ask，headless fail-closed）。
 *
 * 凭证（调研 §6 建议 4）：三 ref（apiKeyRef/secretRef/passphraseRef）= 环境变量名；
 * demo/live 用不同 ref 组（demo 默认 OKX_DEMO_*，live 默认 OKX_*），每次操作经
 * ctx.credentials.resolve() 解析（换 key 无需重启），未命中 → TRADING_CREDENTIALS_MISSING
 * 带 ref 名。
 *
 * @module @dsh-trading/connector-okx
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type {
  AccountBalance,
  Disposable,
  Interval,
  Kline,
  MarketDataService,
  Order,
  OrderRequest,
  OrderStatus,
  Position,
  Ticker,
  TradeService,
} from '@dsh-trading/api'
import { createGetIndicatorsTool } from '@dsh-trading/indicators/tool'
import {
  BAR_MAP,
  type OkxCredentials,
  type OkxInstrument,
  type OkxRestOptions,
  OKX_INTERVAL_VOCABULARY,
  OkxRestClient,
  TradingServiceError,
  normalizeOkxSymbol,
  normalizeSize,
  toCanonicalOkxSymbol,
} from './rest.js'

export * from './rest.js'

/**
 * Cordis 插件名 = preset 行 id（TEMPLATES §8）：`dsh-trading-crypto-*` 市场命名空间，
 * 全仓唯一，绝不使用 `base` 等官方保留 id（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-crypto-connector-okx'

/* ------------------------------------------------------------------ */
/* 配置                                                                    */
/* ------------------------------------------------------------------ */

export interface Config {
  /** 互斥激活总开关（默认 false）：false 时本插件不注册任何服务/工具。 */
  enabled: boolean
  /** 三态环境：'demo'（默认，模拟盘 x-simulated-trading:1）| 'live'（实盘）。 */
  env: 'demo' | 'live'
  /** 交易安全闸门（铁律 #3）：true 时下单类工具强制 dry-run。 */
  dryRun: boolean
  /** 实盘总闸门（默认 false）：false 时 dryRun=false 的请求被结构化拒绝。
   *  true 的第一默认目标是 demo（env='demo'），改 env='live' 是第二次显式解锁。 */
  liveTrading: boolean
  /** 实盘凭证 ref（环境变量名，credentialRef 语义）。 */
  apiKeyRef: string
  secretRef: string
  passphraseRef: string
  /** 模拟盘凭证 ref 组（demo/live key 不通用，调研 §2——按环境取不同 ref 组）。 */
  demoApiKeyRef: string
  demoSecretRef: string
  demoPassphraseRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(false),
  env: Schema.union(['demo', 'live']).default('demo'),
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
  apiKeyRef: Schema.string().default('OKX_API_KEY'),
  secretRef: Schema.string().default('OKX_SECRET_KEY'),
  passphraseRef: Schema.string().default('OKX_PASSPHRASE'),
  demoApiKeyRef: Schema.string().default('OKX_DEMO_API_KEY'),
  demoSecretRef: Schema.string().default('OKX_DEMO_SECRET_KEY'),
  demoPassphraseRef: Schema.string().default('OKX_DEMO_PASSPHRASE'),
})

/** 需要宿主提供的 Cordis 服务。 */
export const inject = ['tools']

/* ------------------------------------------------------------------ */
/* 凭证解析（三 ref，BYOK）                                                 */
/* ------------------------------------------------------------------ */

/** ctx 服务键（与 @dsh-trading/api 的 Context 模块增强一致）。 */
export const TRADING_CRYPTO_MARKET_DATA_KEY = 'tradingCryptoMarketData'
export const TRADING_CRYPTO_TRADE_KEY = 'tradingCryptoTrade'

/**
 * DSH credentials seam 的结构化最小契约（resolve 每次 {value}|undefined）。
 * 本仓不引 @deepseek-ai/dsh-credentials 依赖；形状以其 CredentialProvider 为准。
 */
export interface CredentialResolverLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** credentialRef 语义（DSH credentials 包校验 ^[A-Za-z_][A-Za-z0-9_]*$，镜像镜像）。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 凭证解析所需的最小 ctx 面（单测可直接给 { get } 假 ctx）。 */
export interface CredentialsContext {
  get(name: string): unknown
}

export interface ResolvedCredentialRefs {
  readonly apiKeyRef: string
  readonly secretRef: string
  readonly passphraseRef: string
}

/** env → ref 组：demo 用 demo*Ref（默认 OKX_DEMO_*），live 用 live 组（默认 OKX_*）。 */
export function credentialRefsFor(config: Config, env: 'demo' | 'live' = config.env): ResolvedCredentialRefs {
  return env === 'live'
    ? { apiKeyRef: config.apiKeyRef, secretRef: config.secretRef, passphraseRef: config.passphraseRef }
    : { apiKeyRef: config.demoApiKeyRef, secretRef: config.demoSecretRef, passphraseRef: config.demoPassphraseRef }
}

/**
 * 三 ref 凭证解析：每次操作调用（ctx.credentials 的设计意图——换 key 无需重启插件）。
 * 无 credentials seam 时回落启动环境变量（llm-deepseek 同款降级）。
 * 任何一处未命中/无效 → TRADING_CREDENTIALS_MISSING，消息只带 ref 名（绝不带值）。
 */
export async function resolveCredentials(ctx: CredentialsContext, config: Config): Promise<OkxCredentials> {
  const refs = credentialRefsFor(config)
  for (const ref of [refs.apiKeyRef, refs.secretRef, refs.passphraseRef]) {
    if (!CREDENTIAL_REF_PATTERN.test(ref)) {
      throw new TradingServiceError(
        'TRADING_CREDENTIALS_MISSING',
        `connector-okx: credential ref ${JSON.stringify(ref)} is not a valid environment-variable name (env=${config.env})`,
      )
    }
  }
  const resolver = (ctx.get('credentials') as CredentialResolverLike | undefined) ?? undefined
  const entries: ReadonlyArray<[slot: string, ref: string]> = [
    ['apiKeyRef', refs.apiKeyRef],
    ['secretRef', refs.secretRef],
    ['passphraseRef', refs.passphraseRef],
  ]
  const resolved = await Promise.all(entries.map(async ([slot, ref]) => {
    let value: string | undefined
    if (resolver !== undefined) value = (await resolver.resolve(ref))?.value
    if (value === undefined || value === '') value = process.env[ref]
    return { slot, ref, value }
  }))
  const missing = resolved.filter((part) => part.value === undefined || part.value === '')
  if (missing.length > 0) {
    throw new TradingServiceError(
      'TRADING_CREDENTIALS_MISSING',
      `connector-okx: missing OKX ${config.env} credentials — provide `
        + missing.map((part) => `${part.slot}=${part.ref}`).join(', ')
        + ` through the credentials service or the launching environment (env=${config.env}; `
        + 'demo and live API keys are separate and not interchangeable)',
    )
  }
  const [apiKey, secret, passphrase] = resolved.map((part) => part.value as string)
  return { key: apiKey, secret, passphrase }
}

/* ------------------------------------------------------------------ */
/* MarketDataService（provide 到 tradingCryptoMarketData）                  */
/* ------------------------------------------------------------------ */

export interface SubscribeTickerOptions {
  /** 轮询间隔（ms）。切片阶段 subscribeTicker 以 REST 轮询实现，WS 在后续任务。 */
  readonly intervalMs?: number
}

const SUBSCRIBE_MIN_MS = 250
const SUBSCRIBE_DEFAULT_MS = 5_000

export class OkxMarketDataService extends Service implements MarketDataService {
  // TS 编译期 private 而非 ECMAScript # 私有字段：cordis 跨 realm 代理按类身份校验会炸
  // （connector-binance 同款纪律，replication 坑清单）。
  private readonly client: OkxRestClient

  constructor(ctx: Context, options: OkxRestOptions = {}, client?: OkxRestClient, serviceName: string = TRADING_CRYPTO_MARKET_DATA_KEY) {
    super(ctx, serviceName)
    this.client = client ?? new OkxRestClient(options)
  }

  getTicker(instId: string): Promise<Ticker> {
    return this.client.getTicker(instId)
  }

  getKlines(instId: string, interval: Interval, limit?: number): Promise<Kline[]> {
    return this.client.getKlines(instId, interval, limit)
  }

  /** OKX 专属扩展（MarketDataService 契约之外）：SWAP 资金费率。 */
  getFundingRate(instId: string) {
    return this.client.getFundingRate(instId)
  }

  subscribeTicker(instId: string, cb: (ticker: Ticker) => void, options?: SubscribeTickerOptions): Disposable {
    const ms = Math.max(options?.intervalMs ?? SUBSCRIBE_DEFAULT_MS, SUBSCRIBE_MIN_MS)
    const tick = (): void => {
      // 轮询失败静默跳过（下一 tick 重试）；不产生未处理 rejection。
      void this.client.getTicker(instId).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}

/* ------------------------------------------------------------------ */
/* TradeService（provide 到 tradingCryptoTrade）                            */
/* ------------------------------------------------------------------ */

export interface OkxTradeServiceOptions {
  readonly client: OkxRestClient
  readonly config: Config
  /** 每次操作取三值凭证（内部走 resolveCredentials，未命中抛结构化错误）。 */
  readonly getCredentials: () => Promise<OkxCredentials>
}

const INSTRUMENT_TTL_MS = 60 * 60 * 1000

export class OkxTradeService extends Service implements TradeService {
  private readonly client: OkxRestClient
  private readonly config: Config
  private readonly getCredentials: () => Promise<OkxCredentials>
  /** instId → 规格 缓存；key 前缀 demo:/live: —— demo 与实盘 ctVal 是否一致未实证（调研待验证 #5），按环境分桶。 */
  private readonly instruments = new Map<string, { instrument: OkxInstrument; at: number }>()

  constructor(ctx: Context, options: OkxTradeServiceOptions, serviceName: string = TRADING_CRYPTO_TRADE_KEY) {
    super(ctx, serviceName)
    this.client = options.client
    this.config = options.config
    this.getCredentials = options.getCredentials
  }

  private get simulated(): boolean {
    // 三态环境：env='demo' → 模拟盘头；env='live' → 实盘（见模块头注）。
    return this.config.env === 'demo'
  }

  private auth(credentials: OkxCredentials) {
    return { credentials, simulated: this.simulated }
  }

  /** 规格（带 TTL 缓存；demo/live 分桶）。查不到 → TRADING_UNSUPPORTED_SYMBOL。 */
  private async getInstrument(instId: string): Promise<OkxInstrument> {
    const bucket = `${this.simulated ? 'demo' : 'live'}:${instId}`
    const cached = this.instruments.get(bucket)
    if (cached !== undefined && Date.now() - cached.at < INSTRUMENT_TTL_MS) return cached.instrument
    const instType = instId.endsWith('-SWAP') ? 'SWAP' as const : 'SPOT' as const
    const rows = await this.client.getInstruments(instType, instId)
    const row = rows[0]
    if (row === undefined) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `OKX: unknown instId ${instId} (instType=${instType})`)
    }
    this.instruments.set(bucket, { instrument: row, at: Date.now() })
    return row
  }

  /**
   * 下单（api TradeService 契约）。
   *
   * - req.dryRun !== false（缺省）→ 本地模拟回执（Order.dryRun=true，不触网）；
   * - req.dryRun === false → 真实签名下单（env=demo 加模拟盘头）。liveTrading 闸门
   *   与审批由工具层/base gate 负责，服务层不做二次裁决（connector-binance 先例：
   *   服务保持可复用、闸门收敛在工具工厂）。
   *
   * **sz 单位纪律（调研 §4，实现期最重要的换算）**：
   * - api `OrderRequest.quantity` 语义恒为 base 币数；
   * - SPOT：market 单显式 `tgtCcy: 'base_ccy'` —— OKX 现货市价 buy 缺省按计价币
   *   （USDT）金额，若不显式指定，想买 0.01 BTC 却传 0.01 会被当成 0.01 USDT，
   *   这是两所词汇最大的坑；limit 单恒为 base 币数；
   * - SWAP：`sz` 单位是「张」，币数 = sz × ctVal —— 服务层按 instruments 的
   *   ctVal/lotSz/minSz 换算并本地校验（向下取整，省一次 51000 往返）。
   */
  async placeOrder(req: OrderRequest): Promise<Order> {
    const instId = normalizeOkxSymbol(req.symbol)
    if (req.dryRun !== false) {
      // 契约缺省面：本地模拟回执（工具层另有带市价参照的富回执）。
      return {
        id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol: toCanonicalOkxSymbol(instId),
        side: req.side,
        type: req.type,
        status: 'filled',
        ...(req.price !== undefined ? { price: req.price } : {}),
        quantity: req.quantity,
        dryRun: true,
        timestamp: Date.now(),
      }
    }
    const instrument = await this.getInstrument(instId)
    const normalized = normalizeSize(instId, instrument, req.quantity)
    const params = {
      instId,
      // tdMode（调研 §3.1）：现货=cash（非杠杆）；永续=cross（全仓；isolated 需先设杠杆，二期）。
      tdMode: instrument.instType === 'SWAP' ? ('cross' as const) : ('cash' as const),
      side: req.side,
      ordType: req.type,
      sz: normalized.sz,
      ...(req.type === 'limit' ? { px: String(req.price) } : {}),
      // tgtCcy 是现货市价单专用参数（limit 恒为 base 币数，不带 tgtCcy）。
      ...(req.type === 'market' && normalized.tgtCcy !== undefined ? { tgtCcy: normalized.tgtCcy } : {}),
    }
    const credentials = await this.getCredentials()
    const rows = await this.client.placeOrder(params, this.auth(credentials))
    const first = rows[0] as Record<string, unknown>
    const ordId = typeof first.ordId === 'string' && first.ordId !== '' ? first.ordId : undefined
    if (ordId === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX place order for ${instId}: missing ordId in response`)
    }
    return {
      id: ordId,
      symbol: toCanonicalOkxSymbol(instId),
      side: req.side,
      type: req.type,
      status: 'new',
      ...(req.price !== undefined ? { price: req.price } : {}),
      quantity: req.quantity,
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  /**
   * 撤单。OKX 按 instId + ordId 双键定位，symbol（instId）必填——api 契约的
   * cancelOrder(id) 单参形态对 OKX 不够，扩展第二可选参数（api 包 R3 修订）。
   *
   * 撤单幂等化（调研 §5「实现期定」）：51400（订单已成交/已撤/不存在）/51603（订单
   * 不存在）视作终态成功——撤单语义是「确保不再成交」，订单已终态即达成。
   */
  async cancelOrder(id: string, symbol?: string): Promise<void> {
    if (symbol === undefined || symbol === '') {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        'OKX cancelOrder requires the instId (symbol) together with the order id — OKX locates orders by (instId, ordId)',
      )
    }
    const instId = normalizeOkxSymbol(symbol)
    const credentials = await this.getCredentials()
    try {
      await this.client.cancelOrder(instId, id, this.auth(credentials))
    } catch (error) {
      if (error instanceof TradingServiceError && error.code === 'TRADING_EXCHANGE_ERROR'
        && /\bsCode=(51400|51603)\b/.test(error.message)) {
        return
      }
      throw error
    }
  }

  /** 查单（api TradeService R3 新增成员）：state → OrderStatus 映射见 ORDER_STATE_MAP。 */
  async getOrder(symbol: string, id: string): Promise<Order> {
    const instId = normalizeOkxSymbol(symbol)
    const credentials = await this.getCredentials()
    const rows = await this.client.getOrder(instId, id, this.auth(credentials))
    const d = rows[0] as Record<string, unknown>
    const ordId = typeof d.ordId === 'string' ? d.ordId : id
    const side = d.side === 'sell' ? 'sell' as const : 'buy' as const
    const ordType = d.ordType === 'market' ? 'market' as const : 'limit' as const
    const state = typeof d.state === 'string' ? d.state : ''
    const instrument = await this.getInstrument(instId)
    const toCoins = (exchangeAmount: unknown): number | undefined => {
      const n = typeof exchangeAmount === 'string' || typeof exchangeAmount === 'number' ? Number(exchangeAmount) : Number.NaN
      if (!Number.isFinite(n)) return undefined
      return instrument.instType === 'SWAP' && instrument.ctVal !== undefined ? n * instrument.ctVal : n
    }
    const quantity = toCoins(d.sz)
    if (quantity === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `OKX order ${ordId}: missing/invalid sz`)
    }
    const filledQuantity = toCoins(d.accFillSz)
    const price = typeof d.px === 'string' && d.px !== '' ? Number(d.px) : typeof d.avgPx === 'string' && d.avgPx !== '' ? Number(d.avgPx) : undefined
    const timestamp = typeof d.uTime === 'string' ? Number(d.uTime) : typeof d.cTime === 'string' ? Number(d.cTime) : Date.now()
    return {
      id: ordId,
      symbol: toCanonicalOkxSymbol(instId),
      side,
      type: ordType,
      status: mapOrderState(state),
      ...(price !== undefined && Number.isFinite(price) ? { price } : {}),
      quantity,
      ...(filledQuantity !== undefined ? { filledQuantity } : {}),
      dryRun: false,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    }
  }

  /** 只读持仓（SWAP 的 pos 单位是张 → 经 ctVal 换算成币；net 模式负 pos = short）。 */
  async getPositions(): Promise<Position[]> {
    const credentials = await this.getCredentials()
    const rows = await this.client.getPositions(this.auth(credentials))
    const positions: Position[] = []
    for (const row of rows) {
      const d = row as Record<string, unknown>
      const instId = typeof d.instId === 'string' ? d.instId : undefined
      const pos = typeof d.pos === 'string' || typeof d.pos === 'number' ? Number(d.pos) : Number.NaN
      if (instId === undefined || !Number.isFinite(pos)) continue
      let size = Math.abs(pos)
      // 张 → 币（ctVal 查不到时保留原值并在注释处可见——不虚构换算）。
      if (instId.endsWith('-SWAP')) {
        try {
          const instrument = await this.getInstrument(instId)
          if (instrument.ctVal !== undefined) size = size * instrument.ctVal
        } catch {
          // 规格查不到：保留张数原值（调用方按 instId 语义自行判读）。
        }
      }
      const posSide = d.posSide === 'long' || d.posSide === 'short' ? d.posSide : 'net'
      const side = posSide === 'net' ? (pos >= 0 ? 'long' as const : 'short' as const) : posSide
      const entryPrice = typeof d.avgPx === 'string' ? Number(d.avgPx) : undefined
      const markPrice = typeof d.markPx === 'string' ? Number(d.markPx) : undefined
      const unrealizedPnl = typeof d.upl === 'string' ? Number(d.upl) : undefined
      const leverage = typeof d.lever === 'string' ? Number(d.lever) : undefined
      const timestamp = typeof d.uTime === 'string' ? Number(d.uTime) : Date.now()
      positions.push({
        symbol: toCanonicalOkxSymbol(instId),
        side,
        size,
        ...(entryPrice !== undefined && Number.isFinite(entryPrice) ? { entryPrice } : {}),
        ...(markPrice !== undefined && Number.isFinite(markPrice) ? { markPrice } : {}),
        ...(unrealizedPnl !== undefined && Number.isFinite(unrealizedPnl) ? { unrealizedPnl } : {}),
        ...(leverage !== undefined && Number.isFinite(leverage) ? { leverage } : {}),
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      })
    }
    return positions
  }

  /** 只读余额（TradeService 契约外扩展，crypto_get_balance 工具消费）。 */
  async getBalances(): Promise<AccountBalance[]> {
    const credentials = await this.getCredentials()
    const rows = await this.client.getBalance(this.auth(credentials))
    const balances: AccountBalance[] = []
    for (const row of rows) {
      const account = row as Record<string, unknown>
      const details = Array.isArray(account.details) ? account.details : []
      for (const detail of details) {
        const d = detail as Record<string, unknown>
        const asset = typeof d.ccy === 'string' ? d.ccy : undefined
        if (asset === undefined) continue
        const free = pickNumber(d.availEq, d.availBal, d.eq)
        const locked = pickNumber(d.frozenBal)
        balances.push({ asset, free: free ?? 0, locked: locked ?? 0 })
      }
    }
    return balances
  }
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = typeof value === 'string' && value !== '' ? Number(value) : typeof value === 'number' ? value : Number.NaN
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** OKX state → api OrderStatus（本切片 vocab：live/partially_filled/filled/canceled）。 */
export function mapOrderState(state: string): OrderStatus {
  switch (state) {
    case 'live': return 'new'
    case 'partially_filled': return 'partially_filled'
    case 'filled': return 'filled'
    case 'canceled':
    case 'mmp_canceled': return 'canceled'
    default:
      // 未识别状态保守映射 rejected（OKX 其余 state 如 canceled_* 变体极少见；
      // 保守面宁可标失败让调用方复查，不冒充成交）。
      return 'rejected'
  }
}

// 符号校验/互译统一走 rest.js 的 normalizeOkxSymbol / toCanonicalOkxSymbol
//（docs/symbol-vocabulary.md：输入宽容接受规范形与原生形，输出一律规范形）。

/* ------------------------------------------------------------------ */
/* 下单工具（三态闸门）                                                     */
/* ------------------------------------------------------------------ */

/** crypto_place_order 参数契约（OKX 词汇：instId 带连字符、side/ordType 小写）。 */
export interface PlaceOrderArgs {
  /** 交易对符号：市场规范形（BTCUSDT / BTCUSDT-SWAP）或 OKX 原生形（BTC-USDT）皆收（docs/symbol-vocabulary.md）。 */
  readonly instId: string
  /** 方向（OKX 词汇小写）。 */
  readonly side: 'buy' | 'sell'
  /** 订单类型（OKX ordType 词汇小写）。 */
  readonly type: 'market' | 'limit'
  /** **base 币数量**（SPOT 与 SWAP 同语义；SWAP 由连接器按 ctVal 换算成张）。必须 > 0。 */
  readonly quantity: number
  /** LIMIT 单必填（schema 无法条件必填，execute 内校验），必须 > 0。 */
  readonly price?: number
  /** 缺省视为 true：仅模拟。显式 false 即实盘意图，进入三态闸门 ②/③。 */
  readonly dryRun?: boolean
}

/**
 * 三态闸门判定（顺序即铁律 #3 修订版的裁决顺序；主 agent 裁决的三态环境映射）：
 *  - `reject`   —— ① 请求实盘（dryRun!==true）而 liveTrading=false：结构化拒绝；
 *  - `simulate` —— ② dryRun=true（显式/缺省/被 config.dryRun 强制）：本地模拟回执；
 *  - `live`     —— ③ dryRun=false 且 liveTrading=true：真实签名下单，environment
 *                 决定是否带模拟盘头（demo=第一默认目标；live=实盘，base 闸门照旧 ask）。
 */
export type OrderGateVerdict =
  | { action: 'reject'; code: 'TRADING_LIVE_TRADING_DISABLED'; message: string }
  | { action: 'simulate' }
  | { action: 'live'; environment: 'demo' | 'live' }

export function evaluateOrderGate(config: Config, args: PlaceOrderArgs): OrderGateVerdict {
  const requestedDryRun = args.dryRun ?? true
  if (!requestedDryRun && !config.liveTrading) {
    return {
      action: 'reject',
      code: 'TRADING_LIVE_TRADING_DISABLED',
      message:
        `crypto_place_order rejected: the call requests real execution (dryRun=${String(args.dryRun)}) `
        + 'but live trading is disabled (liveTrading=false). Ask the user to enable liveTrading explicitly '
        + 'after confirmation, or keep dryRun=true for a simulated fill.',
    }
  }
  if (requestedDryRun || config.dryRun) return { action: 'simulate' }
  return { action: 'live', environment: config.env }
}

/** 参数校验（模型调用问题抛普通 Error；服务故障才用错误词汇，connector-binance 先例）。 */
function validatePlaceOrderArgs(args: PlaceOrderArgs): void {
  // 规范词汇（2026-08-31）：接受市场规范形（BTCUSDT）与 OKX 原生形（BTC-USDT）。
  try {
    normalizeOkxSymbol(args.instId)
  } catch {
    throw new Error(`crypto_place_order: invalid instId ${JSON.stringify(args.instId)} — expected market-canonical (BTCUSDT / BTCUSDT-SWAP) or OKX native (BTC-USDT / BTC-USDT-SWAP)`)
  }
  if (args.side !== 'buy' && args.side !== 'sell') {
    throw new Error(`crypto_place_order: invalid side ${JSON.stringify(args.side)} — expected buy or sell`)
  }
  if (args.type !== 'market' && args.type !== 'limit') {
    throw new Error(`crypto_place_order: invalid type ${JSON.stringify(args.type)} — expected market or limit`)
  }
  if (typeof args.quantity !== 'number' || !Number.isFinite(args.quantity) || args.quantity <= 0) {
    throw new Error(`crypto_place_order: invalid quantity ${JSON.stringify(args.quantity)} — expected a positive base-asset quantity`)
  }
  if (args.type === 'limit' && (typeof args.price !== 'number' || !Number.isFinite(args.price) || args.price <= 0)) {
    throw new Error('crypto_place_order: LIMIT orders require a positive price')
  }
}

function normalizePlaceOrderArgs(raw: unknown): PlaceOrderArgs {
  const args = (raw ?? {}) as PlaceOrderArgs
  const instId = typeof args.instId === 'string' ? args.instId.trim().toUpperCase() : (undefined as unknown as string)
  return { ...args, instId }
}

/** DRY-RUN 回执（connector-binance 同款形状；参照行情来自 OKX 公共 ticker）。 */
export interface DryRunReference {
  source: 'okx-public-ticker'
  price?: number
  bid?: number
  ask?: number
  timestamp?: number
  unavailable?: string
}

export async function buildDryRunReceipt(
  args: PlaceOrderArgs,
  marketData: Pick<OkxMarketDataService, 'getTicker'>,
): Promise<string> {
  let reference: DryRunReference
  try {
    const ticker = await marketData.getTicker(args.instId)
    reference = {
      source: 'okx-public-ticker',
      price: ticker.price,
      bid: ticker.bid,
      ask: ticker.ask,
      timestamp: ticker.timestamp,
    }
  } catch (error) {
    // 模拟单不因参照行情失败而失败：明确标注 unavailable 即可。
    reference = {
      source: 'okx-public-ticker',
      unavailable: error instanceof Error ? error.message : String(error),
    }
  }
  return JSON.stringify({
    status: 'filled',
    dryRun: true,
    note: 'DRY-RUN — simulated fill; no order was sent to OKX. The reference price is market data only, not a fill price.',
    id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    instId: args.instId,
    side: args.side,
    type: args.type,
    quantity: args.quantity,
    quantityUnit: 'base-asset coins (SWAP orders would be converted to contracts by ctVal)',
    ...(args.type === 'limit' ? { price: args.price } : {}),
    reference,
    timestamp: Date.now(),
  })
}

export interface PlaceOrderToolDeps {
  /** 行情服务（dry-run 回执的市价参照），按接口取用，不直连 REST。 */
  readonly marketData: Pick<OkxMarketDataService, 'getTicker'>
  /** 交易服务（闸门 ③ 的真实签名下单路径）。 */
  readonly trade: TradeService
  /** 插件配置（dryRun 强制模拟 / liveTrading 总闸门 / env 三态）。 */
  readonly config: Config
}

/**
 * crypto_place_order 工具工厂（独立导出便于单测三态闸门矩阵）。
 *
 * 审批不在这里做：dryRun!==true 的调用由 @dsh-trading/base 的 gate 插件在
 * `tools/pre-execute` waterfall 统一 ask（headless 下 ask=deny，fail-closed）；
 * 工具内不再重复调 ctx.approval。
 */
export function createPlaceOrderTool(deps: PlaceOrderToolDeps) {
  return defineTool({
    name: 'crypto_place_order',
    description:
      'Place an OKX spot or perpetual-swap (SWAP) order, or simulate one. instId accepts market-canonical (BTCUSDT, BTCUSDT-SWAP) or OKX native (BTC-USDT, BTC-USDT-SWAP) vocabulary. '
      + 'quantity is in BASE-ASSET coins: spot MARKET orders are sent with tgtCcy=base_ccy (OKX default for buys is quote-currency amount — a known trap), '
      + 'and SWAP quantities are converted to contracts via ctVal automatically. dryRun defaults to true and returns a DRY-RUN simulated fill receipt '
      + 'with the current market price as reference. Real execution (dryRun=false) requires the plugin liveTrading switch plus user approval; '
      + 'with env=demo (default) the order is signed and routed to the OKX demo exchange (simulated trading), env=live is real money.',
    parameters: {
      instId: {
        type: 'string',
        required: true,
        description: 'Instrument id — market-canonical (BTCUSDT spot / BTCUSDT-SWAP perpetual) or OKX native (BTC-USDT / BTC-USDT-SWAP)',
      },
      side: {
        type: 'string',
        enum: ['buy', 'sell'],
        required: true,
        description: 'Order side (OKX lowercase vocabulary)',
      },
      type: {
        type: 'string',
        enum: ['market', 'limit'],
        required: true,
        description: 'Order type (OKX ordType)',
      },
      quantity: {
        type: 'number',
        required: true,
        description: 'Base asset quantity in coins (e.g. 0.01 BTC); SWAP orders are converted to contracts internally',
      },
      price: {
        type: 'number',
        description: 'Limit price; required when type=limit',
      },
      dryRun: {
        type: 'boolean',
        description:
          'true (default) = simulate only and return a DRY-RUN receipt; false = request real execution (gated by liveTrading, env and user approval)',
        default: true,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = normalizePlaceOrderArgs(raw)
      validatePlaceOrderArgs(args)

      const verdict = evaluateOrderGate(deps.config, args)
      if (verdict.action === 'reject') {
        // 闸门 ①：结构化拒绝，不抛异常（模型可直接读到原因与出路）。
        return JSON.stringify({ status: 'rejected', code: verdict.code, message: verdict.message })
      }
      if (verdict.action === 'simulate') {
        // 闸门 ②：模拟成交回执（DRY-RUN 标记 + 市价参照）。
        return buildDryRunReceipt(args, deps.marketData)
      }
      // 闸门 ③：真实签名下单（env=demo → x-simulated-trading:1；env=live → 实盘）。
      const order = await deps.trade.placeOrder({
        symbol: args.instId,
        side: args.side,
        type: args.type,
        quantity: args.quantity,
        ...(args.type === 'limit' ? { price: args.price } : {}),
        dryRun: false,
      })
      return JSON.stringify(order)
    },
  })
}

/* ------------------------------------------------------------------ */
/* 工具注册（duplicate-safe：同名工具已被占有时跳过 + log）                    */
/* ------------------------------------------------------------------ */

interface ToolsServiceLike {
  register(definition: { name: string }): unknown
  get(name: string): { name: string } | undefined
}

/**
 * 互斥激活的注册面：dsh-tools 对同名重复注册直接抛错（会炸 boot/preset 挂载），
 * 而互斥纪律下「同时至多一个连接器激活」只是配置约定。这里把冲突降级为
 * 「先到先得 + log」：已被占用（binance 或 kit-crypto 先注册）的名字跳过。
 */
function registerTool(ctx: Context, tool: ReturnType<typeof defineTool>, log: LogLike): void {
  const tools = ctx.tools as unknown as ToolsServiceLike
  if (tools.get(tool.name) !== undefined) {
    log.warn(
      '[dsh-trading-crypto-connector-okx] tool %s already registered by another provider — skipped (mutual exclusion: at most one crypto connector/toolset may be active)',
      tool.name,
    )
    return
  }
  tools.register(tool)
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                                */
/* ------------------------------------------------------------------ */

/** 宿主 logger 的最小形状（ctx.logger(name) 不可用时回落 console，保证任何面可启动）。 */
interface LogLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

function logger(ctx: Context): LogLike {
  const service = (ctx as unknown as { logger?: (name: string) => LogLike }).logger
  return typeof service === 'function' ? service(name) : console
}

/** 本连接器的路由 provider slug（docs/exchange-routing.md §2.2）。 */
export const ROUTER_PROVIDER = 'okx'

/** 市场路由服务的最小消费面（api 包 MarketRouterService 同构；不定死接口）。 */
export interface MarketRouterLike {
  activeProvider(market: string): string | undefined
}

export function apply(ctx: Context, config: Config): void {
  const log = logger(ctx)

  // 互斥激活：默认 false——静默退出，不注册任何东西。
  if (!config.enabled) {
    log.info(
      '[dsh-trading-crypto-connector-okx] not activated (enabled=false) — tradingCryptoMarketData/tradingCryptoTrade and crypto_* tools stay unregistered',
    )
    return
  }

  // 市场路由裁决（2026-08-29 设置驱动重构）：router 存在且选了别人 → 静默退出。
  const router = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingMarketRouter') as MarketRouterLike | undefined
  const active = router?.activeProvider('crypto')
  if (router !== undefined && active !== ROUTER_PROVIDER) {
    log.info(
      '[dsh-trading-crypto-connector-okx] market router selects %s for crypto — not activated; set dshtrading.markets.crypto.provider to okx to use this connector',
      String(active ?? '(unset)'),
    )
    return
  }

  const client = new OkxRestClient()
  const marketData = new OkxMarketDataService(ctx, {}, client)
  const trade = new OkxTradeService(ctx, {
    client,
    config,
    getCredentials: () => resolveCredentials(ctx, config),
  })

  // inject：等行情服务就绪后注册公共面工具；工具只面向服务接口，不直连 REST。
  ctx.inject(['tradingCryptoMarketData'], () => {
    // WS1b（docs/analysis-roadmap.md #2）：指标计算工具——共享工厂，K 线走本 connector
    // 行情服务（路由选中的数据源），计算走 @dsh-trading/indicators。
    registerTool(ctx, createGetIndicatorsTool({ marketData, providerLabel: 'okx' }), log)
    registerTool(ctx, defineTool({
      name: 'crypto_get_ticker',
      description:
        'Get the latest public ticker (last price, bid/ask, 24h volume) for an OKX instrument via the OKX public REST API. '
        + 'instId accepts market-canonical (BTCUSDT spot, BTCUSDT-SWAP perpetual) or OKX native vocabulary. No credentials required.',
      parameters: {
        instId: {
          type: 'string',
          required: true,
          description: 'Instrument id — market-canonical (BTCUSDT / BTCUSDT-SWAP) or OKX native (BTC-USDT / BTC-USDT-SWAP)',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const ticker = await marketData.getTicker(args.instId)
        return JSON.stringify(ticker)
      },
    }), log)

    registerTool(ctx, defineTool({
      name: 'crypto_get_klines',
      description:
        'Get recent public klines (candles: open/high/low/close/volume) for an OKX instrument via the OKX public REST API. '
        + 'Intervals use the dsh-trading vocabulary (1m..1M); 1d maps to OKX 1Dutc (UTC day boundary, consistent with Binance daily bars). '
        + 'No credentials required.',
      parameters: {
        instId: {
          type: 'string',
          required: true,
          description: 'Instrument id — market-canonical (BTCUSDT / BTCUSDT-SWAP) or OKX native (BTC-USDT / BTC-USDT-SWAP)',
        },
        interval: {
          type: 'string',
          enum: [...OKX_INTERVAL_VOCABULARY],
          description: 'Kline interval (dsh-trading vocabulary; no 8h — OKX has no 8-hour bar)',
          default: '1h',
        },
        limit: {
          type: 'integer',
          description: 'Number of candles to return (1-300, OKX max 300)',
          default: 100,
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const interval = (args.interval ?? '1h') as Interval
        const limit = args.limit ?? 100
        const klines = await marketData.getKlines(args.instId, interval, limit)
        return JSON.stringify(klines)
      },
    }), log)

    registerTool(ctx, defineTool({
      name: 'crypto_funding_rate',
      description:
        'Get the current and next funding rate for an OKX perpetual swap (instId like BTCUSDT-SWAP or BTC-USDT-SWAP) via the OKX public REST API. '
        + 'No credentials required.',
      parameters: {
        instId: {
          type: 'string',
          required: true,
          description: 'OKX perpetual swap instrument id, e.g. BTCUSDT-SWAP (canonical) or BTC-USDT-SWAP (native)',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const funding = await marketData.getFundingRate(args.instId)
        return JSON.stringify(funding)
      },
    }), log)
  })

  // 交易面工具（闸门与签名下单路径）。
  ctx.inject(['tradingCryptoTrade'], () => {
    registerTool(ctx, createPlaceOrderTool({ marketData, trade, config }), log)

    registerTool(ctx, defineTool({
      name: 'crypto_cancel_order',
      description: 'Cancel an OKX order by (instId, ordId). Cancelling an already-terminal order (filled/canceled) is reported as already-terminal, not an error.',
      parameters: {
        instId: { type: 'string', required: true, description: 'Instrument id the order belongs to — canonical (BTCUSDT) or native (BTC-USDT)' },
        ordId: { type: 'string', required: true, description: 'OKX order id (ordId from place/get order)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        await trade.cancelOrder(args.ordId, args.instId)
        return JSON.stringify({ status: 'canceled', instId: args.instId, ordId: args.ordId, timestamp: Date.now() })
      },
    }), log)

    registerTool(ctx, defineTool({
      name: 'crypto_get_order',
      description: 'Query one OKX order by (instId, ordId): state, filled quantity, average price. Read-only.',
      parameters: {
        instId: { type: 'string', required: true, description: 'Instrument id — canonical (BTCUSDT / BTCUSDT-SWAP) or native (BTC-USDT)' },
        ordId: { type: 'string', required: true, description: 'OKX order id' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const order = await trade.getOrder(args.instId, args.ordId)
        return JSON.stringify(order)
      },
    }), log)

    registerTool(ctx, defineTool({
      name: 'crypto_get_balance',
      description: 'Read the OKX account balances (available/frozen per currency) via the signed REST API. Requires the configured credential refs to resolve.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        const balances = await trade.getBalances()
        return JSON.stringify({ env: config.env, simulated: config.env === 'demo', balances })
      },
    }), log)

    registerTool(ctx, defineTool({
      name: 'crypto_get_positions',
      description: 'Read the OKX account positions (size converted from contracts to coins for swaps, entry/mark price, unrealized PnL, leverage). Read-only.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        const positions = await trade.getPositions()
        return JSON.stringify({ env: config.env, simulated: config.env === 'demo', positions })
      },
    }), log)
  })
}

// BAR_MAP 导出转口：映射表归 rest.ts 所有，这里 re-export 保持单一事实来源。
export { BAR_MAP }
