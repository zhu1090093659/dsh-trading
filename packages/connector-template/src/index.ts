/**
 * 【模板】交易所连接器插件入口骨架 —— 由生成器展开为新交易所插件后逐项填充。
 *
 * 结构（对照 connector-okx，本仓第一个真实 TradeService 参照系）：
 *   - Config：互斥激活（enabled 默认 false）+ 三态环境（env=demo|live）+ 铁律 #3
 *     双闸门（dryRun/liveTrading）+ BYOK 三 ref 凭证（demo/live 各一组）。
 *   - 服务：__EXCHANGE__MarketDataService（trading__MARKET_CAP__MarketData）与
 *     __EXCHANGE__TradeService（trading__MARKET_CAP__Trade——第一个真实交易面形态，
 *     数据面-only 的连接器删掉 TradeService 与交易面工具即可）。
 *   - 工具：市场短前缀（__MARKET___get_ticker 等），闸门模式
 *     /^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/ 由 base 拥有，市场工具名必须落在此式内。
 *   - 互斥激活：同一市场同一服务键至多一个连接器 enabled=true（okx/binance 先例，
 *     方案 B 互斥 + C 交易服务分离，详见 docs/okx-integration.md §8.2）。
 *
 * TODO 清单（按实现顺序）：
 *   1. rest.ts：baseUrl/签名/端点/字段解析/错误码映射/单位换算（见该文件头部清单）。
 *   2. index.ts：凭证解析校验（resolveCredentials 已给 BYOK+环境变量回落骨架；
 *      若交易所凭证是两值形，删 passphrase 槽并同步 Config ref）。
 *   3. 工具描述：填入真实端点语义、单位陷阱提醒（描述里写明 quantity 恒为 base 币数）。
 *   4. 单测：签名已知向量（rest.ts 导出原语）、闸门三路径、映射、凭证校验；
 *      出网验证按 docs/connector-playbook.md 的 R 序列执行并留原始响应证据。
 *   5. preset 接线：市场 bundle 的 assets/preset/<market>-trader/agent.cordis.yml
 *      加 isolate 组行（isolate 键 = 服务名）；bundle dependencies 加本包。
 *
 * 生成器：node scripts/new-connector.mjs --slug bybit --title Bybit
 *
 * @module @dsh-trading/connector-__EXCHANGE_SLUG__
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
import {
  type ExchangeCredentials,
  type ExchangeRestOptions,
  ExchangeRestClient,
  TradingServiceError,
} from './rest.js'

export * from './rest.js'

/* ------------------------------------------------------------------ */
/* 占位常量（生成器按 token 整体替换；模板未展开也可编译）                       */
/* ------------------------------------------------------------------ */

/** 市场短前缀（工具名前缀 = 闸门模式前缀，如 crypto）。 */
const MARKET = '__MARKET__'
/** 市场标题（服务键 infix，如 Crypto）。 */
const MARKET_CAP = '__MARKET_CAP__'
/** 交易所 slug（包名/插件名/行 id 的一部分）。 */
const EXCHANGE_SLUG = '__EXCHANGE_SLUG__'
/** 交易所标题（类名/描述，如 Bybit）。 */
const EXCHANGE = '__EXCHANGE__'
/** 环境变量 ref 前缀（如 BYBIT）。 */
const ENV_PREFIX = '__ENV_PREFIX__'

/**
 * Cordis 插件名 = preset 行 id（TEMPLATES §8）：市场命名空间 + 交易所 slug，
 * 全仓唯一，绝不使用 `base` 等官方保留 id（insert-only 铁律 #1）。
 */
export const name = `dsh-trading-${MARKET}-connector-${EXCHANGE_SLUG}`

/* ------------------------------------------------------------------ */
/* 配置                                                                    */
/* ------------------------------------------------------------------ */

export interface Config {
  /** 互斥激活总开关（默认 false）：false 时本插件不注册任何服务/工具。 */
  enabled: boolean
  /** 三态环境：'demo'（默认，模拟盘/测试环境）| 'live'（实盘）。无模拟盘的交易所锁 'live'。 */
  env: 'demo' | 'live'
  /** 交易安全闸门（铁律 #3）：true 时下单类工具强制 dry-run。 */
  dryRun: boolean
  /** 实盘总闸门（默认 false）：false 时 dryRun=false 的请求被结构化拒绝。 */
  liveTrading: boolean
  /** 实盘凭证 ref（环境变量名，credentialRef 语义，BYOK）。 */
  apiKeyRef: string
  secretRef: string
  passphraseRef: string
  /** 模拟盘/测试凭证 ref 组（demo/live key 通常不通用）。 */
  demoApiKeyRef: string
  demoSecretRef: string
  demoPassphraseRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(false),
  env: Schema.union(['demo', 'live']).default('demo'),
  dryRun: Schema.boolean().default(true),
  liveTrading: Schema.boolean().default(false),
  apiKeyRef: Schema.string().default(`${ENV_PREFIX}_API_KEY`),
  secretRef: Schema.string().default(`${ENV_PREFIX}_SECRET_KEY`),
  passphraseRef: Schema.string().default(`${ENV_PREFIX}_PASSPHRASE`),
  demoApiKeyRef: Schema.string().default(`${ENV_PREFIX}_DEMO_API_KEY`),
  demoSecretRef: Schema.string().default(`${ENV_PREFIX}_DEMO_SECRET_KEY`),
  demoPassphraseRef: Schema.string().default(`${ENV_PREFIX}_DEMO_PASSPHRASE`),
})

/** 需要宿主提供的 Cordis 服务。 */
export const inject = ['tools']

/* ------------------------------------------------------------------ */
/* 服务键（与 @dsh-trading/api 的 Context 模块增强一致）                      */
/* ------------------------------------------------------------------ */

/** 行情服务键（api 增强：trading<Market>MarketData）。 */
export const TRADING_MARKET_DATA_KEY = `trading${MARKET_CAP}MarketData`
/** 交易服务键（api 增强：trading<Market>Trade；数据面-only 连接器不提供）。 */
export const TRADING_TRADE_KEY = `trading${MARKET_CAP}Trade`

/* ------------------------------------------------------------------ */
/* 凭证解析（BYOK，三 ref —— 两值形交易所删到两 ref）                          */
/* ------------------------------------------------------------------ */

/**
 * DSH credentials seam 的结构化最小契约（resolve 每次 {value}|undefined）。
 * 本仓不引 @deepseek-ai/dsh-credentials 依赖；形状以其 CredentialProvider 为准。
 */
export interface CredentialResolverLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** credentialRef 语义（DSH credentials 包校验 ^[A-Za-z_][A-Za-z0-9_]*$，镜像）。 */
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

/** env → ref 组：demo 用 demo*Ref，live 用 live 组。 */
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
export async function resolveCredentials(ctx: CredentialsContext, config: Config): Promise<ExchangeCredentials> {
  const refs = credentialRefsFor(config)
  for (const ref of [refs.apiKeyRef, refs.secretRef, refs.passphraseRef]) {
    if (!CREDENTIAL_REF_PATTERN.test(ref)) {
      throw new TradingServiceError(
        'TRADING_CREDENTIALS_MISSING',
        `connector-${EXCHANGE_SLUG}: credential ref ${JSON.stringify(ref)} is not a valid environment-variable name (env=${config.env})`,
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
      `connector-${EXCHANGE_SLUG}: missing ${EXCHANGE} ${config.env} credentials — provide `
        + missing.map((part) => `${part.slot}=${part.ref}`).join(', ')
        + ` through the credentials service or the launching environment (env=${config.env}; `
        + 'demo and live API keys are separate and not interchangeable)',
    )
  }
  const [apiKey, secret, passphrase] = resolved.map((part) => part.value as string)
  return { key: apiKey, secret, passphrase }
}

/* ------------------------------------------------------------------ */
/* MarketDataService（provide 到 trading<Market>MarketData）                */
/* ------------------------------------------------------------------ */

export interface SubscribeTickerOptions {
  /** 轮询间隔（ms）。切片阶段 subscribeTicker 以 REST 轮询实现，WS 在后续任务。 */
  readonly intervalMs?: number
}

const SUBSCRIBE_MIN_MS = 250
const SUBSCRIBE_DEFAULT_MS = 5_000

export class __EXCHANGE__MarketDataService extends Service implements MarketDataService {
  // TS 编译期 private 而非 ECMAScript # 私有字段：cordis 跨 realm 代理按类身份校验会炸
  // （connector-binance 同款纪律，replication 坑清单）。
  private readonly client: ExchangeRestClient

  constructor(ctx: Context, options: ExchangeRestOptions = {}, client?: ExchangeRestClient, serviceName: string = TRADING_MARKET_DATA_KEY) {
    super(ctx, serviceName)
    this.client = client ?? new ExchangeRestClient(options)
  }

  getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
  }

  /** 交易所专属扩展（契约之外，如资金费率）：按需添加，工具名用市场前缀 + 语义词。 */

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: SubscribeTickerOptions): Disposable {
    const ms = Math.max(options?.intervalMs ?? SUBSCRIBE_DEFAULT_MS, SUBSCRIBE_MIN_MS)
    const tick = (): void => {
      // 轮询失败静默跳过（下一 tick 重试）；不产生未处理 rejection。
      void this.client.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}

/* ------------------------------------------------------------------ */
/* TradeService（provide 到 trading<Market>Trade；数据面-only 连接器整段删除）   */
/* ------------------------------------------------------------------ */

export interface __EXCHANGE__TradeServiceOptions {
  readonly client: ExchangeRestClient
  readonly config: Config
  /** 每次操作取三值凭证（内部走 resolveCredentials，未命中抛结构化错误）。 */
  readonly getCredentials: () => Promise<ExchangeCredentials>
}

export class __EXCHANGE__TradeService extends Service implements TradeService {
  private readonly client: ExchangeRestClient
  private readonly config: Config
  private readonly getCredentials: () => Promise<ExchangeCredentials>

  constructor(ctx: Context, options: __EXCHANGE__TradeServiceOptions, serviceName: string = TRADING_TRADE_KEY) {
    super(ctx, serviceName)
    this.client = options.client
    this.config = options.config
    this.getCredentials = options.getCredentials
  }

  /**
   * 下单（api TradeService 契约）。
   *
   * - req.dryRun !== false（缺省）→ 本地模拟回执（Order.dryRun=true，不触网）；
   * - req.dryRun === false → 真实签名下单。liveTrading 闸门与审批由工具层/base gate
   *   负责，服务层不做二次裁决（connector-binance 先例：闸门收敛在工具工厂）。
   *
   * TODO: 单位换算（api quantity 恒为 base 币数；合约按 ctVal 等换算成交易所原始单位、
   *       现货市价单的计价币陷阱——见 rest.ts 头部清单第 7 条）。
   */
  async placeOrder(req: OrderRequest): Promise<Order> {
    if (req.dryRun !== false) {
      // 契约缺省面：本地模拟回执（工具层另有带市价参照的富回执）。
      return {
        id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol: req.symbol,
        side: req.side,
        type: req.type,
        status: 'filled',
        ...(req.price !== undefined ? { price: req.price } : {}),
        quantity: req.quantity,
        dryRun: true,
        timestamp: Date.now(),
      }
    }
    const credentials = await this.getCredentials()
    const rows = await this.client.placeOrder(
      { /* TODO: 按交易所参数形状构造（含单位换算后的 sz） */ },
      credentials,
    )
    const first = rows[0] as Record<string, unknown>
    const ordId = typeof first.ordId === 'string' && first.ordId !== '' ? first.ordId : undefined
    if (ordId === undefined) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `${EXCHANGE} place order for ${req.symbol}: missing ordId in response`)
    }
    return {
      id: ordId,
      symbol: req.symbol,
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
   * 撤单。若交易所按 (symbol, id) 双键定位，api 契约的 cancelOrder(id) 单参形态
   * 不够时扩展第二可选参数（@dsh-trading/api R3 先例）。
   * TODO: 撤单幂等化——交易所的「已终态」错误码视作成功（参照 OKX 51400/51603）。
   */
  async cancelOrder(id: string, symbol?: string): Promise<void> {
    if (symbol === undefined || symbol === '') {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `${EXCHANGE} cancelOrder requires the symbol together with the order id`)
    }
    const credentials = await this.getCredentials()
    await this.client.cancelOrder(symbol, id, credentials)
  }

  /** 查单：state → api OrderStatus 映射（mapOrderState，TODO 按交易所 state 词汇填表）。 */
  async getOrder(symbol: string, id: string): Promise<Order> {
    const credentials = await this.getCredentials()
    const rows = await this.client.getOrder(symbol, id, credentials)
    const d = rows[0] as Record<string, unknown>
    const ordId = typeof d.ordId === 'string' ? d.ordId : id
    const side = d.side === 'sell' ? 'sell' as const : 'buy' as const
    const ordType = d.ordType === 'market' ? 'market' as const : 'limit' as const
    const state = typeof d.state === 'string' ? d.state : ''
    const quantity = typeof d.sz === 'string' || typeof d.sz === 'number' ? Number(d.sz) : Number.NaN
    if (!Number.isFinite(quantity)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `${EXCHANGE} order ${ordId}: missing/invalid sz`)
    }
    const price = typeof d.px === 'string' && d.px !== '' ? Number(d.px) : typeof d.avgPx === 'string' && d.avgPx !== '' ? Number(d.avgPx) : undefined
    const timestamp = typeof d.uTime === 'string' ? Number(d.uTime) : typeof d.cTime === 'string' ? Number(d.cTime) : Date.now()
    return {
      id: ordId,
      symbol,
      side,
      type: ordType,
      status: mapOrderState(state),
      ...(price !== undefined && Number.isFinite(price) ? { price } : {}),
      quantity,
      dryRun: false,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    }
  }

  /** 只读持仓。TODO: 合约单位 → 币数换算。 */
  async getPositions(): Promise<Position[]> {
    const credentials = await this.getCredentials()
    const rows = await this.client.getPositions(credentials)
    const positions: Position[] = []
    for (const row of rows) {
      const d = row as Record<string, unknown>
      const symbol = typeof d.instId === 'string' ? d.instId : undefined
      const pos = typeof d.pos === 'string' || typeof d.pos === 'number' ? Number(d.pos) : Number.NaN
      if (symbol === undefined || !Number.isFinite(pos)) continue
      const posSide = d.posSide === 'long' || d.posSide === 'short' ? d.posSide : 'net'
      positions.push({
        symbol,
        side: posSide === 'net' ? (pos >= 0 ? 'long' as const : 'short' as const) : posSide,
        size: Math.abs(pos),
        ...(typeof d.avgPx === 'string' ? { entryPrice: Number(d.avgPx) } : {}),
        ...(typeof d.markPx === 'string' ? { markPrice: Number(d.markPx) } : {}),
        ...(typeof d.upl === 'string' ? { unrealizedPnl: Number(d.upl) } : {}),
        ...(typeof d.lever === 'string' ? { leverage: Number(d.lever) } : {}),
        timestamp: typeof d.uTime === 'string' ? Number(d.uTime) : Date.now(),
      })
    }
    return positions
  }

  /** 只读余额（TradeService 契约外扩展，_get_balance 工具消费）。 */
  async getBalances(): Promise<AccountBalance[]> {
    const credentials = await this.getCredentials()
    const rows = await this.client.getBalance(credentials)
    const balances: AccountBalance[] = []
    for (const row of rows) {
      const account = row as Record<string, unknown>
      const details = Array.isArray(account.details) ? account.details : []
      for (const detail of details) {
        const d = detail as Record<string, unknown>
        const asset = typeof d.ccy === 'string' ? d.ccy : undefined
        if (asset === undefined) continue
        balances.push({
          asset,
          free: typeof d.availEq === 'string' ? Number(d.availEq) : 0,
          locked: typeof d.frozenBal === 'string' ? Number(d.frozenBal) : 0,
        })
      }
    }
    return balances
  }
}

/** 交易所 state → api OrderStatus（TODO: 按交易所词汇填表；未识别保守 rejected）。 */
export function mapOrderState(state: string): OrderStatus {
  switch (state) {
    case 'live': return 'new'
    case 'partially_filled': return 'partially_filled'
    case 'filled': return 'filled'
    case 'canceled': return 'canceled'
    default: return 'rejected'
  }
}

/* ------------------------------------------------------------------ */
/* 下单工具（三态闸门，市场无关模板可直接用）                                    */
/* ------------------------------------------------------------------ */

export interface PlaceOrderArgs {
  /** 交易所原生 symbol（执行前归一化到交易所词汇）。 */
  readonly symbol: string
  /** 方向（交易所词汇小写）。 */
  readonly side: 'buy' | 'sell'
  /** 订单类型（交易所词汇小写）。 */
  readonly type: 'market' | 'limit'
  /** **base 币数量**（swaps 由连接器换算成合约单位）。必须 > 0。 */
  readonly quantity: number
  /** LIMIT 单必填（schema 无法条件必填，execute 内校验），必须 > 0。 */
  readonly price?: number
  /** 缺省视为 true：仅模拟。显式 false 即实盘意图，进入三态闸门 ②/③。 */
  readonly dryRun?: boolean
}

/**
 * 三态闸门判定（顺序即铁律 #3 修订版的裁决顺序）：
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
        `${MARKET}_place_order rejected: the call requests real execution (dryRun=${String(args.dryRun)}) `
        + 'but live trading is disabled (liveTrading=false). Ask the user to enable liveTrading explicitly '
        + 'after confirmation, or keep dryRun=true for a simulated fill.',
    }
  }
  if (requestedDryRun || config.dryRun) return { action: 'simulate' }
  return { action: 'live', environment: config.env }
}

/** 参数校验（模型调用问题抛普通 Error；服务故障才用错误词汇，connector-binance 先例）。 */
function validatePlaceOrderArgs(args: PlaceOrderArgs): void {
  if (typeof args.symbol !== 'string' || args.symbol.trim() === '') {
    throw new Error(`${MARKET}_place_order: invalid symbol ${JSON.stringify(args.symbol)} — expected a non-empty exchange symbol`)
  }
  if (args.side !== 'buy' && args.side !== 'sell') {
    throw new Error(`${MARKET}_place_order: invalid side ${JSON.stringify(args.side)} — expected buy or sell`)
  }
  if (args.type !== 'market' && args.type !== 'limit') {
    throw new Error(`${MARKET}_place_order: invalid type ${JSON.stringify(args.type)} — expected market or limit`)
  }
  if (typeof args.quantity !== 'number' || !Number.isFinite(args.quantity) || args.quantity <= 0) {
    throw new Error(`${MARKET}_place_order: invalid quantity ${JSON.stringify(args.quantity)} — expected a positive base-asset quantity`)
  }
  if (args.type === 'limit' && (typeof args.price !== 'number' || !Number.isFinite(args.price) || args.price <= 0)) {
    throw new Error(`${MARKET}_place_order: LIMIT orders require a positive price`)
  }
}

function normalizePlaceOrderArgs(raw: unknown): PlaceOrderArgs {
  const args = (raw ?? {}) as PlaceOrderArgs
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : (undefined as unknown as string)
  return { ...args, symbol }
}

/** DRY-RUN 回执（connector-binance 同款形状；参照行情来自交易所公共 ticker）。 */
export interface DryRunReference {
  source: string
  price?: number
  bid?: number
  ask?: number
  timestamp?: number
  unavailable?: string
}

export async function buildDryRunReceipt(
  args: PlaceOrderArgs,
  marketData: Pick<__EXCHANGE__MarketDataService, 'getTicker'>,
): Promise<string> {
  let reference: DryRunReference
  try {
    const ticker = await marketData.getTicker(args.symbol)
    reference = {
      source: `${EXCHANGE_SLUG}-public-ticker`,
      price: ticker.price,
      bid: ticker.bid,
      ask: ticker.ask,
      timestamp: ticker.timestamp,
    }
  } catch (error) {
    // 模拟单不因参照行情失败而失败：明确标注 unavailable 即可。
    reference = {
      source: `${EXCHANGE_SLUG}-public-ticker`,
      unavailable: error instanceof Error ? error.message : String(error),
    }
  }
  return JSON.stringify({
    status: 'filled',
    dryRun: true,
    note: `DRY-RUN — simulated fill; no order was sent to ${EXCHANGE}. The reference price is market data only, not a fill price.`,
    id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: args.symbol,
    side: args.side,
    type: args.type,
    quantity: args.quantity,
    ...(args.type === 'limit' ? { price: args.price } : {}),
    reference,
    timestamp: Date.now(),
  })
}

export interface PlaceOrderToolDeps {
  /** 行情服务（dry-run 回执的市价参照），按接口取用，不直连 REST。 */
  readonly marketData: Pick<__EXCHANGE__MarketDataService, 'getTicker'>
  /** 交易服务（闸门 ③ 的真实签名下单路径）。 */
  readonly trade: TradeService
  /** 插件配置（dryRun 强制模拟 / liveTrading 总闸门 / env 三态）。 */
  readonly config: Config
}

/**
 * <market>_place_order 工具工厂（独立导出便于单测三态闸门矩阵）。
 *
 * 审批不在这里做：dryRun!==true 的调用由 @dsh-trading/base 的 gate 插件在
 * `tools/pre-execute` waterfall 统一 ask（headless 下 ask=deny，fail-closed）；
 * 工具内不再重复调 ctx.approval。
 */
export function createPlaceOrderTool(deps: PlaceOrderToolDeps) {
  return defineTool({
    name: `${MARKET}_place_order`,
    description:
      `Place a ${EXCHANGE} order, or simulate one. symbol uses ${EXCHANGE} vocabulary. `
      + 'quantity is in BASE-ASSET coins. dryRun defaults to true and returns a DRY-RUN simulated fill receipt '
      + 'with the current market price as reference. Real execution (dryRun=false) requires the plugin liveTrading '
      + 'switch plus user approval; env=demo (default) routes to the simulated environment, env=live is real money.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: `${EXCHANGE} instrument/symbol id`,
      },
      side: {
        type: 'string',
        enum: ['buy', 'sell'],
        required: true,
        description: 'Order side',
      },
      type: {
        type: 'string',
        enum: ['market', 'limit'],
        required: true,
        description: 'Order type',
      },
      quantity: {
        type: 'number',
        required: true,
        description: 'Base asset quantity in coins',
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
      // 闸门 ③：真实签名下单（env=demo → 模拟环境；env=live → 实盘）。
      const order = await deps.trade.placeOrder({
        symbol: args.symbol,
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
 * 「先到先得 + log」：已被占用的名字跳过。
 */
function registerTool(ctx: Context, tool: ReturnType<typeof defineTool>, log: LogLike): void {
  const tools = ctx.tools as unknown as ToolsServiceLike
  if (tools.get(tool.name) !== undefined) {
    log.warn(
      `[dsh-trading-${MARKET}-connector-${EXCHANGE_SLUG}] tool %s already registered by another provider — skipped (mutual exclusion: at most one ${MARKET} connector/toolset may be active)`,
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

export function apply(ctx: Context, config: Config): void {
  const log = logger(ctx)

  // 互斥激活：默认 false——静默退出，不注册任何东西。
  if (!config.enabled) {
    log.info(
      `[dsh-trading-${MARKET}-connector-${EXCHANGE_SLUG}] not activated (enabled=false) — ${TRADING_MARKET_DATA_KEY}/${TRADING_TRADE_KEY} and ${MARKET}_* tools stay unregistered`,
    )
    return
  }

  const client = new ExchangeRestClient()
  const marketData = new __EXCHANGE__MarketDataService(ctx, {}, client)
  const trade = new __EXCHANGE__TradeService(ctx, {
    client,
    config,
    getCredentials: () => resolveCredentials(ctx, config),
  })

  // 数据面：等行情服务就绪后注册公共面工具；工具只面向服务接口，不直连 REST。
  ctx.inject([TRADING_MARKET_DATA_KEY], () => {
    registerTool(ctx, defineTool({
      name: `${MARKET}_get_ticker`,
      description: `Get the latest public ticker (last price, bid/ask, 24h volume) for a ${EXCHANGE} instrument via the public REST API. No credentials required.`,
      parameters: {
        symbol: { type: 'string', required: true, description: `${EXCHANGE} instrument/symbol id` },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const ticker = await marketData.getTicker(args.symbol)
        return JSON.stringify(ticker)
      },
    }), log)

    registerTool(ctx, defineTool({
      name: `${MARKET}_get_klines`,
      description: `Get recent public klines (candles: open/high/low/close/volume) for a ${EXCHANGE} instrument via the public REST API. Intervals use the dsh-trading vocabulary (1m..1M). No credentials required.`,
      parameters: {
        symbol: { type: 'string', required: true, description: `${EXCHANGE} instrument/symbol id` },
        interval: {
          type: 'string',
          enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'],
          description: 'Kline interval (dsh-trading vocabulary)',
          default: '1h',
        },
        limit: {
          type: 'integer',
          description: 'Number of candles to return',
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
        const klines = await marketData.getKlines(args.symbol, interval, limit)
        return JSON.stringify(klines)
      },
    }), log)
  })

  // 交易面工具（闸门与签名下单路径）。
  ctx.inject([TRADING_TRADE_KEY], () => {
    registerTool(ctx, createPlaceOrderTool({ marketData, trade, config }), log)

    registerTool(ctx, defineTool({
      name: `${MARKET}_cancel_order`,
      description: `Cancel a ${EXCHANGE} order by (symbol, id). Cancelling an already-terminal order is reported as already-terminal, not an error.`,
      parameters: {
        symbol: { type: 'string', required: true, description: `${EXCHANGE} symbol the order belongs to` },
        ordId: { type: 'string', required: true, description: 'Exchange order id' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        await trade.cancelOrder(args.ordId, args.symbol)
        return JSON.stringify({ status: 'canceled', symbol: args.symbol, ordId: args.ordId, timestamp: Date.now() })
      },
    }), log)

    registerTool(ctx, defineTool({
      name: `${MARKET}_get_order`,
      description: `Query one ${EXCHANGE} order by (symbol, id): state, filled quantity, average price. Read-only.`,
      parameters: {
        symbol: { type: 'string', required: true, description: `${EXCHANGE} symbol the order belongs to` },
        ordId: { type: 'string', required: true, description: 'Exchange order id' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const order = await trade.getOrder(args.symbol, args.ordId)
        return JSON.stringify(order)
      },
    }), log)

    registerTool(ctx, defineTool({
      name: `${MARKET}_get_balance`,
      description: `Read the ${EXCHANGE} account balances (available/frozen per currency) via the signed REST API. Requires the configured credential refs to resolve.`,
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
      name: `${MARKET}_get_positions`,
      description: `Read the ${EXCHANGE} account positions (size, entry/mark price, unrealized PnL, leverage). Read-only.`,
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
