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
  /** 交易对符号，**市场规范词汇**（docs/symbol-vocabulary.md：crypto=BTCUSDT，us=AAPL，cn=600519.SH，hk=00700.HK）。 */
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

/** 衍生品市场指标快照（持仓量/多空比/资金费等）。 */
export interface DerivativesData {
  /** 交易对符号，市场规范词汇（如 BTCUSDT 或 BTCUSDT-SWAP）。 */
  readonly symbol: string
  /** 数据来源（如 binance / okx）。 */
  readonly source: string
  /** 未平仓合约量（Open Interest，base 币数或张数）。 */
  readonly openInterest?: number
  /** 未平仓合约总价值（USD 或 quote 计价）。 */
  readonly openInterestValue?: number
  /** 多空人数比（Long/Short Account Ratio）。 */
  readonly longShortRatio?: number
  /** 大户持仓多空比（Top Trader Long/Short Position Ratio）。 */
  readonly topTraderLongShortRatio?: number
  /** 主动买入/卖出量比（Taker Buy/Sell Volume Ratio）。 */
  readonly takerBuySellRatio?: number
  /** 最新资金费率（小数，如 0.0001 表示 0.01%）。 */
  readonly fundingRate?: number
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
}

/** 加密标的代币经济学与基本面快照。 */
export interface CryptoFundamentals {
  /** 规范符号或代币代码（如 BTCUSDT 或 BTC）。 */
  readonly symbol: string
  /** 标的资产名称（如 Bitcoin）。 */
  readonly name?: string
  /** 全球市值排名（Market Cap Rank）。 */
  readonly rank?: number
  /** 流通市值（USD 计价）。 */
  readonly marketCapUsd?: number
  /** 完全稀释估值（FDV，USD 计价）。 */
  readonly fdvUsd?: number
  /** 流通供应量。 */
  readonly circulatingSupply?: number
  /** 总供应量 / 最大供应量。 */
  readonly totalSupply?: number
  /** 24h 交易量（USD 计价）。 */
  readonly volume24hUsd?: number
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
}

/** 股票市场标的基本面与财务估值快照（US/CN/HK）。 */
export interface StockFundamentals {
  /** 标的规范符号（如 AAPL, 600519.SH, 00700.HK）。 */
  readonly symbol: string
  /** 公司/标的名称。 */
  readonly name?: string
  /** 总市值（本位币计价）。 */
  readonly marketCap?: number
  /** 流通市值（A 股/港股适用）。 */
  readonly floatMarketCap?: number
  /** 滚动市盈率 PE (TTM)。 */
  readonly peTtm?: number
  /** 动态/预测市盈率 Forward / Dynamic PE。 */
  readonly peDynamic?: number
  /** 市净率 PB。 */
  readonly pb?: number
  /** 每股收益 EPS。 */
  readonly eps?: number
  /** 每股净资产 BPS。 */
  readonly bps?: number
  /** 股息率（小数，如 0.015 表示 1.5%）。 */
  readonly dividendYield?: number
  /** 换手率（小数或百分比）。 */
  readonly turnoverRate?: number
  /** 52 周最高价。 */
  readonly fiftyTwoWeekHigh?: number
  /** 52 周最低价。 */
  readonly fiftyTwoWeekLow?: number
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
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
 * 符号词汇（2026-08-31 规范，docs/symbol-vocabulary.md）：入参接受市场规范形与连接器原生形，
 * 输出 `symbol` 一律市场规范形——消费方（GUI/Agent/工作流）与数据源方言解耦。
 */
export interface MarketDataService {
  getTicker(symbol: string): Promise<Ticker>
  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]>
  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void): Disposable
}

/**
 * 交易服务契约：placeOrder 默认 dry-run；实盘前必须过插件 liveTrading 开关与
 * ctx.approval.request（交互形态；headless 下 ask=deny，fail-closed [S4]）。
 *
 * R3（okx 切片 2026-08-29）修订：cancelOrder 增加可选 symbol、新增 getOrder——
 * OKX 按 (instId, ordId) 双键定位订单，单参 id 形态不够；无其他实现方，扩展向后兼容。
 */
export interface TradeService {
  placeOrder(req: OrderRequest): Promise<Order>
  /** 撤单。symbol 可选：按 (symbol, id) 双键定位订单的交易所（如 OKX）必须提供。 */
  cancelOrder(id: string, symbol?: string): Promise<void>
  /** 查询单笔订单状态（按 (symbol, id) 双键）。 */
  getOrder(symbol: string, id: string): Promise<Order>
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

/**
 * Cordis Context 服务键（能力三角色之「声明」）：市场命名空间键由契约包统一声明，
 * 连接器 provide、消费方 inject 时获得完整类型。此处仅类型增强——本包保持
 * 零运行时依赖，不产生任何 JS 输出。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** crypto 市场行情服务（由 Binance 连接器以公共 REST 提供，无需凭证）。 */
    tradingCryptoMarketData: MarketDataService
    /** us 市场行情服务（由 Stooq 连接器以公共 CSV 端点提供，无需凭证；us 复制 2026-08-31 补齐）。 */
    tradingUsMarketData: MarketDataService
    /** cn 市场行情服务（由腾讯连接器以公共端点提供，无需凭证；cn+hk 切片 2026-08-31 补齐）。 */
    tradingCnMarketData: MarketDataService
    /** hk 市场行情服务（由腾讯连接器同包双实例提供，config.market 分流；cn+hk 切片 2026-08-31 补齐）。 */
    tradingHkMarketData: MarketDataService
    /**
     * crypto 市场交易服务（R3 2026-08-29 补齐，crypto 市场第一个真实 TradeService）：
     * 由 connector-okx 实现（签名 demo/live 下单），与 connector-binance 经
     * Config.enabled 互斥激活同一 tradingCryptoMarketData 键时一并 provide。
     */
    tradingCryptoTrade: TradeService
    /**
     * 市场路由服务（R5 2026-08-29 补齐，@dsh-trading/router 提供）：
     * 连接器 apply 时 consult activeProvider(market) 决定是否激活——用户设置
     * dshtrading.markets.<market>.provider 选谁谁激活（docs/exchange-routing.md）。
     */
    tradingMarketRouter: MarketRouterService
    /**
     * 行情服务注册表（2026-08-30 注册表模式定稿，@dsh-trading/router 同插件提供）：
     * 连接器 host 面数据行注册，GUI 行情桥按路由当前值惰性解析（热切换）。
     */
    tradingMarketDataRegistry: MarketDataRegistry
  }
}

/**
 * 行情服务注册表契约（router 插件提供，2026-08-30 注册表模式定稿）：
 * 连接器 host 面数据行不再互斥式 provide 市场键，而是全部注册进本注册表；
 * 消费方（GUI 行情桥）经 active() 按路由当前值惰性解析——settings 变更即刻生效
 * （GUI 热切换），无 watch、无进程重启。preset 平面不走注册表：会话内数据源
 * 一致性是有意语义，切交易所对会话 = 新建会话生效（docs/exchange-routing.md §2.2）。
 *
 * 与 tradeProvider 预留的衔接：本注册表只承载 MarketDataService；数据/交易分离
 * 落地时 TradeService 走独立注册面（不复用本键），铁律 #4 到时再抽象。
 */
export interface MarketDataRegistration {
  /** 市场 slug（crypto/us/cn/hk；开放词汇，新市场 = 新键）。 */
  readonly market: string
  /** 提供者 slug（binance/okx/…；开放词汇，第三方连接器可注册新 slug）。 */
  readonly provider: string
  readonly service: MarketDataService
}

export interface MarketDataRegistry {
  /**
   * 注册一个市场的某 provider 行情服务；同 (market, provider) 重复注册抛错
   * （配置错误必须响亮）。返回注销函数（调用方包进 ctx.effect 随 fiber 注销）。
   */
  register(market: string, provider: string, service: MarketDataService): () => void
  /**
   * 路由裁决后的当前激活注册项：router 选中的 provider 已注册 → 返回之；
   * 选中了但未注册（包未装/enabled=false）→ undefined（调用方面向用户报错，
   * 不静默降级到别家——用户设置是权威）；router 无该市场路由（未知市场键）
   * 且恰好一个注册项 → 返回之（新市场零配置可用）；否则 undefined。
   */
  active(market: string): MarketDataRegistration | undefined
  /** 某市场全部注册项（诊断/设置 UI 展示用）。 */
  list(market: string): readonly MarketDataRegistration[]
}

/**
 * 市场路由服务契约（router 插件提供）：按市场查询当前激活的数据/交易所提供方。
 * 用户设置（dshtrading namespace，settings.yaml）是权威；无设置时 = 组合默认值
 * （现状零变化）。供应商取值与连接器的 provider slug 比对，相符者激活。
 */
export interface MarketRouterService {
  /** 某市场当前激活的 provider slug（settings resolved：用户层赢，缺省 base 默认）。 */
  activeProvider(market: string): string | undefined
  /** 订阅激活变化（settings commit 驱动）。 */
  watch(cb: (next: string | undefined, prev: string | undefined) => void): () => void
}
