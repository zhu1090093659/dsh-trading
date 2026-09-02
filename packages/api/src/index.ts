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
  /** 标的/公司名称（如“紫光股份”、“苹果”、“腾讯控股”；部分数据源可缺省）。 */
  readonly name?: string
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
  /** 官方昨收（涨跌基准锚点；部分数据源可缺省，缺省时消费方退回日 K 自算）。 */
  readonly prevClose?: number
  /** 相对昨收的涨跌幅（百分比，如 -0.89 表示 -0.89%；部分数据源可缺省）。 */
  readonly changePercent?: number
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
  /** 静态市盈率 PE (静)。 */
  readonly peStatic?: number
  /** 动态/预测市盈率 Forward / Dynamic PE。 */
  readonly peDynamic?: number
  /** 市净率 PB。 */
  readonly pb?: number
  /** 市销率 PS。 */
  readonly ps?: number
  /** 每股收益 EPS。 */
  readonly eps?: number
  /** 每股净资产 BPS。 */
  readonly bps?: number
  /** 股息率（小数，如 0.015 表示 1.5%）。 */
  readonly dividendYield?: number
  /** 换手率（小数或百分比）。 */
  readonly turnoverRate?: number
  /** 振幅（百分比）。 */
  readonly amplitudePercent?: number
  /** 涨停价（A 股适用）。 */
  readonly limitUpPrice?: number
  /** 跌停价（A 股适用）。 */
  readonly limitDownPrice?: number
  /** 52 周最高价。 */
  readonly fiftyTwoWeekHigh?: number
  /** 52 周最低价。 */
  readonly fiftyTwoWeekLow?: number
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
}

/** 盘口档位（价格 + 挂单量，量单位=标的基准单位：股票股、crypto 币）。 */
export interface OrderbookLevel {
  readonly price: number
  readonly amount: number
}

/**
 * 盘口快照（GUI「盘口」竖栏用，issue #39）。实现保证：bids 按价格降序（买一在前）、
 * asks 按价格升序（卖一在前），档位数由数据源决定（沪深五档、crypto 常见 5~20 档）。
 */
export interface Orderbook {
  readonly symbol: string
  readonly bids: readonly OrderbookLevel[]
  readonly asks: readonly OrderbookLevel[]
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
}

/** 逐笔成交（taker 视角：side 为主动方；流水单条）。 */
export interface TradeTick {
  /** 交易所成交 id（字符串透传，排序稳定性由时间戳保证）。 */
  readonly id: string
  readonly symbol: string
  readonly price: number
  /** 成交量（基准单位，同 OrderbookLevel.amount）。 */
  readonly amount: number
  /** 主动方向：buy=主动买（外盘）、sell=主动卖（内盘）；数据源缺方向时 unknown。 */
  readonly side: 'buy' | 'sell' | 'unknown'
  readonly timestamp: number
}

/** 单期财务指标数值与同比变动。 */
export interface FinancialCell {
  /** 指标数值（如 14.18 元 或 19.02%）。 */
  readonly value?: number
  /** 同比增长率（百分比，如 -3.69 表示 -3.69%，+522.77 表示 +522.77%）。 */
  readonly changePercent?: number
}

/** 单个财务指标行（多期序列）。 */
export interface FinancialIndicatorRow {
  readonly id: string
  readonly name: string
  readonly unit?: string
  /** 期别映射 -> 该期读数与同比（key 对应 periods 数组中的元素，如 '2025/H1'）。 */
  readonly values: Record<string, FinancialCell>
}

/** 财务指标大类分组（如“每股指标”、“盈利能力”、“现金流量”等）。 */
export interface FinancialReportGroup {
  readonly id: string
  readonly title: string
  readonly rows: FinancialIndicatorRow[]
}

/** 历史多期财务报表与指标矩阵（富途牛牛同款）。 */
export interface FinancialReportMatrix {
  /** 币种（如 CNY / HKD / USD）。 */
  readonly currency: string
  /** 最新报告期标题（如 "2026财年H1 财报"）。 */
  readonly latestReportTitle?: string
  /** 报告期有序列表（由远及近，如 ['2024/H1', '2024/Q3', '2024/FY', '2025/H1', '2025/Q3', '2025/FY', '2026/Q1', '2026/H1']）。 */
  readonly periods: string[]
  /** 分组列表。 */
  readonly groups: FinancialReportGroup[]
}

/** 股东持股信息行。 */
export interface ShareholderItem {
  readonly name: string
  readonly shares?: number
  readonly ratio?: number
  readonly change?: string
}

/** 公司/标的简况信息。 */
export interface CompanyProfile {
  readonly symbol: string
  readonly name?: string
  readonly fullName?: string
  readonly nameEn?: string
  readonly industry?: string
  readonly sector?: string
  readonly legalRepresentative?: string
  readonly chairman?: string
  readonly generalManager?: string
  readonly boardSecretary?: string
  readonly registeredCapital?: string
  readonly address?: string
  readonly businessScope?: string
  readonly employeeCount?: string
  readonly description?: string
  readonly listingDate?: string
  readonly website?: string
  readonly executives?: Array<{ name: string; title: string }>
}

/** 机构盈利预测与目标价一致预期（富途 预测）。 */
export interface ForecastSummary {
  readonly epsCurrentYear?: number
  readonly epsNextYear?: number
  readonly revenueGrowthAvg?: number
  readonly netProfitGrowthAvg?: number
  readonly targetPriceAvg?: number
  readonly buyRatingCount?: number
  readonly holdRatingCount?: number
  readonly sellRatingCount?: number
  readonly totalOrgs?: number
  readonly items?: Array<{
    readonly year: string
    readonly eps: number
    readonly revenue: number
    readonly netProfit: number
    readonly orgCount?: number
  }>
}

/** 研报精选（富途 晨星研报/券商研报）。 */
export interface ResearchReportItem {
  readonly id: string
  readonly title: string
  readonly orgName: string
  readonly author?: string
  readonly rating?: string
  readonly publishDate: string
  readonly summary?: string
  readonly url?: string
}

/** 主营构成（富途 经营分析/主营构成）。 */
export interface MainOperationSegment {
  readonly segmentName: string
  readonly classification: 'product' | 'industry' | 'region'
  readonly revenue: number
  readonly revenueRatio: number
  readonly grossProfit?: number
  readonly grossMargin?: number
}

/** 经营效率指标（富途 经营分析/经营效率）。 */
export interface OperatingEfficiency {
  readonly inventoryTurnoverDays?: number
  readonly accountsReceivableTurnoverDays?: number
  readonly operatingCycleDays?: number
  readonly totalAssetTurnover?: number
  readonly netProfitMargin?: number
  readonly grossProfitMargin?: number
  readonly currentRatio?: number
  readonly quickRatio?: number
  readonly roe?: number
}

/** 股东增减持 / 内部人交易（富途 聪明钱/股东增减持）。 */
export interface InsiderTradeItem {
  readonly holderName: string
  readonly changeType: '增持' | '减持' | '不变' | '新进' | string
  readonly changeShares: number
  readonly changeRatio?: number
  readonly postHoldingRatio?: number
  readonly date?: string
  readonly averagePrice?: number
}

/** 机构持股明细（富途 聪明钱/机构持股）。 */
export interface InstitutionalHoldingItem {
  readonly orgName?: string
  readonly orgType: string
  readonly orgCount?: number
  readonly holdingShares: number
  readonly holdingRatio: number
  readonly marketCap?: number
  readonly change?: string
  readonly changeRatio?: number
}

/** 分红派息方案（富途 公司行动/分红派息）。 */
export interface DividendItem {
  readonly planYear: string
  readonly dividendPlan: string
  readonly cashDividend?: number
  readonly exDividendDate?: string
  readonly dividendDate?: string
  readonly recordDate?: string
  readonly dividendYield?: number
}

/** 股份回购方案（富途 公司行动/回购）。 */
export interface BuybackItem {
  readonly date: string
  readonly buybackAmount?: number
  readonly buybackShares?: number
  readonly priceRange?: string
  readonly status: string
}

/** 拆股并股 / 送转（富途 公司行动/拆股并股）。 */
export interface SplitItem {
  readonly date: string
  readonly ratio: string
  readonly description: string
}

/** 股东户数与筹码集中度（富途 聪明钱）。 */
export interface HolderNumSummary {
  readonly totalHolders?: number
  readonly totalHoldersChangeRatio?: number
  readonly avgFreeShares?: number
  readonly avgHoldAmount?: number
  readonly concentration?: string
  readonly reportDate?: string
}

/** 聚合基本面数据包（供 Bridge 端点向前端全量交付）。 */
export interface FundamentalsPackage {
  readonly market: string
  readonly symbol: string
  readonly stock?: StockFundamentals
  readonly crypto?: CryptoFundamentals
  readonly matrix?: FinancialReportMatrix
  readonly profile?: CompanyProfile
  readonly shareholders?: ShareholderItem[]
  readonly forecast?: ForecastSummary
  readonly reports?: ResearchReportItem[]
  readonly mainOperations?: MainOperationSegment[]
  readonly efficiency?: OperatingEfficiency
  readonly insiderTrades?: InsiderTradeItem[]
  readonly institutionalHoldings?: InstitutionalHoldingItem[]
  readonly holderSummary?: HolderNumSummary
  readonly dividends?: DividendItem[]
  readonly buybacks?: BuybackItem[]
  readonly splits?: SplitItem[]
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

/** 成交流水单条（GUI 交易台「成交历史」用，issue #40）。 */
export interface TradeFill {
  /** 交易所成交 id。 */
  readonly id: string
  readonly symbol: string
  readonly side: OrderSide
  readonly price: number
  /** 成交量（base 币数）。 */
  readonly amount: number
  /** 手续费（绝对值，币种由 feeAsset 表达）。 */
  readonly fee?: number
  readonly feeAsset?: string
  readonly timestamp: number
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
  /**
   * 查询本市场/交易所支持的全部标的名册（动态全集，Issue #15）。
   * 输出 `symbol` 一律市场规范词汇（docs/symbol-vocabulary.md）。
   * 可选方法：无公开全集端点的数据源（如 tencent/yahoo/stooq）可缺省或由桥/前端回退。
   */
  listInstruments?(): Promise<Array<{ symbol: string; name?: string }>>
  /**
   * 标的基本面与估值快照（GUI「基本面」页签用，2026-09-02）。
   * 可选方法：仅当数据源在同一公共端点里携带基本面字段时实现
   * （腾讯行情行 cn/hk 已实现）；未实现的市场由消费方降级为派生数据（日K 52 周高低）。
   * 输出 `symbol` 一律市场规范词汇（docs/symbol-vocabulary.md）。
   */
  getFundamentals?(symbol: string): Promise<StockFundamentals>
  /**
   * 衍生品市场指标快照（GUI「衍生品」面板用，issue #38，2026-09-02）：持仓量/
   * 多空比/资金费等微观结构数据，crypto 永续合约市场专属。
   * 可选方法：现货/股票数据源不实现；未实现时消费方直接隐藏面板（不降级不报错）。
   * 入参接受规范形与连接器原生形，输出 `symbol` 一律规范词汇 SWAP 形（BTCUSDT-SWAP）。
   */
  getDerivatives?(symbol: string): Promise<DerivativesData>
  /**
   * 盘口快照（GUI「盘口」竖栏用，issue #39）：档位词汇见 Orderbook。可选方法：
   * 数据源无盘口能力时不实现（如 stooq/yahoo、腾讯 r_hk 港股行档位全 0）。
   * 入参接受规范形与连接器原生形，输出 `symbol` 一律市场规范词汇。
   */
  getOrderbook?(symbol: string): Promise<Orderbook>
  /**
   * 最近逐笔成交流水（GUI「分笔」用，issue #39）：取最近 limit 笔（缺省 ≤50），
   * **时间升序（旧→新）**，与 K 线序列同向；方向缺省的数据源 side='unknown'。
   * 可选方法：无公共逐笔端点的数据源（腾讯沪深行情行）不实现。
   */
  getRecentTrades?(symbol: string, limit?: number): Promise<TradeTick[]>
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
  /**
   * 账户余额快照（issue #40 GUI 交易台；只读，需凭证）。
   * 可选方法：实现方已有只读余额面时实现（connector-okx 的 crypto_get_balance 同源）。
   */
  getBalances?(): Promise<AccountBalance[]>
  /**
   * 当前挂单列表（issue #40 GUI 交易台；只读，需凭证）。
   * 可选方法：无批量挂单端点的实现方可缺省（GUI 隐藏挂单区）。
   * 输出 `symbol` 一律市场规范词汇；status 只含 new / partially_filled。
   */
  listOpenOrders?(symbol?: string): Promise<Order[]>
  /**
   * 最近成交流水（issue #40 GUI 交易台；只读，需凭证）。
   * 可选方法：时间升序（旧→新），最多 limit 条（缺省 ≤50）。
   */
  listTradeFills?(symbol?: string, limit?: number): Promise<TradeFill[]>
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
     * 交易服务注册表（issue #40 GUI 交易台，@dsh-trading/api 类型声明）：
     * 与 tradingMarketDataRegistry 同构的宿主平面注册面——交易连接器 host 面数据行
     * 注册，GUI 桥按路由当前值惰性解析。**注册不改变安全语义**：placeOrder 的
     * 服务缝闸门（dryRun 缺省 true + liveTrading 显式开关）随服务实例生效；
     * GUI 桥只放行 dry-run 下单与只读查询，实盘路径仍走 Agent 工具的 base 审批闸门。
     */
    tradingTradeRegistry: TradeRegistry
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

/** 交易服务注册项（tradingTradeRegistry 的条目，issue #40）。 */
export interface TradeRegistration {
  readonly market: string
  readonly provider: string
  readonly service: TradeService
}

/**
 * 交易服务注册表（router 插件同款注册模式，issue #40）：交易连接器在 host 面
 * 数据行注册（凭证经 ctx.credentials / 环境变量解析，缺失时只读方法 fail-closed
 * 报 TRADING_CREDENTIALS_MISSING）；注册面本身不做安全裁决——闸门在服务缝
 * （placeOrder 三态）与桥层（GUI 只放行 dry-run）。
 */
export interface TradeRegistry {
  register(market: string, provider: string, service: TradeService): () => void
  active(market: string): TradeRegistration | undefined
  list(market: string): readonly TradeRegistration[]
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
