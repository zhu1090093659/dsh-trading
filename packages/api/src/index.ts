/**
 * @dsh-trading/api — 纯类型契约包（crypto-slice-plan §关键接口草案）。
 *
 * 零运行时、零依赖：服务契约由连接器实现（ctx 键按市场命名空间，如 ctx.tradingCrypto），
 * 消费方只依赖这里的类型。交易安全闸门（铁律 #3）在类型层面体现为
 * OrderRequest.dryRun 默认 true、错误词汇含 LIVE_TRADING_DISABLED / APPROVAL_DENIED。
 *
 * @module @dsh-trading/api
 */

/** K线周期（Binance 现货/合约 interval 词汇）。 */
export type Interval =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '8h'
  | '12h'
  | '1d'
  | '3d'
  | '1w'
  | '1M'

/** 最新行情快照（公共数据，无需凭证）。 */
export interface Ticker {
  /** 交易对符号，如 `BTCUSDT`。 */
  readonly symbol: string
  /** 最新成交价。 */
  readonly price: number
  /** 最优买价（部分数据源可缺省）。 */
  readonly bid?: number
  /** 最优卖价（部分数据源可缺省）。 */
  readonly ask?: number
  /** 24h 成交量（base 资产计）。 */
  readonly volume?: number
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
}

/** 单根 K 线。 */
export interface Kline {
  readonly openTime: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly closeTime: number
}

export type PositionSide = 'long' | 'short'

/** 持仓快照。 */
export interface Position {
  readonly symbol: string
  readonly side: PositionSide
  /** 仓位数量（正数；方向由 side 表达）。 */
  readonly size: number
  readonly entryPrice: number
  readonly markPrice?: number
  readonly unrealizedPnl?: number
  readonly leverage?: number
  readonly timestamp: number
}

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'limit' | 'market'
export type OrderStatus = 'new' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired'

/** 下单请求（安全闸门：dryRun 缺省视为 true）。 */
export interface OrderRequest {
  readonly symbol: string
  readonly side: OrderSide
  readonly type: OrderType
  readonly quantity: number
  /** limit 单必填。 */
  readonly price?: number
  /** 缺省/true 时仅模拟，不触碰交易所。实盘还受插件 liveTrading 闸门与 approval 约束 [S4]。 */
  readonly dryRun?: boolean
}

/** 订单回执/状态。 */
export interface Order {
  readonly id: string
  readonly symbol: string
  readonly side: OrderSide
  readonly type: OrderType
  readonly status: OrderStatus
  readonly price?: number
  readonly quantity: number
  readonly filledQuantity?: number
  /** 本次订单是否为模拟单（回执必须显式回带，防 dry-run 语义丢失）。 */
  readonly dryRun: boolean
  readonly timestamp: number
}

export interface AccountBalance {
  readonly asset: string
  readonly free: number
  readonly locked: number
}

/** 账户快照（需凭证，BYOK 经 ctx.credentials 引用 [S4]）。 */
export interface IAccount {
  readonly id: string
  readonly balances: readonly AccountBalance[]
}

/** 订阅句柄：dispose 即退订（连接器用 ctx.effect/cordis 生命周期托管）。 */
export interface Disposable {
  dispose(): void
}

/**
 * 行情服务契约：由市场连接器实现，注册到按市场命名空间的 ctx 键（如 ctx.tradingCrypto）。
 */
export interface MarketDataService {
  getTicker(symbol: string): Promise<Ticker>
  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]>
  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void): Disposable
}

/**
 * 交易服务契约：placeOrder 默认 dry-run；实盘前必须过插件 liveTrading 开关与
 * ctx.approval.request（交互形态；headless 下 ask=deny，fail-closed [S4]）。
 */
export interface TradeService {
  placeOrder(req: OrderRequest): Promise<Order>
  cancelOrder(id: string): Promise<void>
  getPositions(): Promise<Position[]>
}

/**
 * 统一错误词汇（本包不做运行时 Error 类；实现方自行映射到该词汇）。
 * 命名空间 `TRADING_`，跨市场/跨连接器稳定。
 */
export type TradingErrorCode =
  /** 功能未实现（骨架/占位阶段）。 */
  | 'TRADING_NOT_IMPLEMENTED'
  | 'TRADING_UNSUPPORTED_SYMBOL'
  | 'TRADING_UNSUPPORTED_INTERVAL'
  /** 凭证缺失或无效（ctx.credentials 引用解析失败 [S4]）。 */
  | 'TRADING_CREDENTIALS_MISSING'
  | 'TRADING_AUTH_FAILED'
  | 'TRADING_RATE_LIMITED'
  | 'TRADING_NETWORK'
  | 'TRADING_INSUFFICIENT_BALANCE'
  /** liveTrading=false 闸门拒绝实盘（铁律 #3）。 */
  | 'TRADING_LIVE_TRADING_DISABLED'
  /** approval 被拒/无应答（headless fail-closed [S4]）。 */
  | 'TRADING_APPROVAL_DENIED'
  /** 本次为 dry-run 模拟结果（非故障语义）。 */
  | 'TRADING_DRY_RUN'
  | 'TRADING_EXCHANGE_ERROR'
  | 'TRADING_UNKNOWN'

/** 结构化错误载体（实现方在 Error 上附加该形状，或直接以 code 抛出）。 */
export interface TradingError {
  readonly code: TradingErrorCode
  readonly message: string
  /** 交易所原始错误/上游 cause。 */
  readonly cause?: unknown
}
