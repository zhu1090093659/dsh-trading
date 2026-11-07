/**
 * @dshtrading/api — 纯类型契约包（crypto-slice-plan §关键接口草案）。
 *
 * 零运行时、零依赖：服务契约由连接器实现（ctx 键按市场命名空间，如 ctx.tradingCrypto），
 * 消费方只依赖这里的类型。交易安全闸门（铁律 #3）在类型层面体现为
 * OrderRequest.dryRun 默认 true、错误词汇含 LIVE_TRADING_DISABLED / APPROVAL_DENIED。
 *
 * @module @dshtrading/api
 */

// cordis Context augmentation 的解析锚点（2026-10-08）：无此 type-only import，TS2664 下
// augmentation 整体失效；且它必须是**有绑定且被引用**的 type import——无绑定的 `import type {}`
// 会被 dts 生成器消除，只把 declare module 留在 lib/index.d.ts 里，消费方程序中它退化为新的
// ambient 模块、Context 身份分裂（router 实测 7 条 TS2379/TS2339）。
// 配套 tsdown.config.ts 的 `external: ['@deepseek-ai/cordis']`：否则 dts 生成器把该外部类型解析成
// ./node_modules/.pnpm/... 相对路径，锚点同样失效。改这里请一并跑消费方 tsc（router 是判据样本）。
import type { Context as CordisContext } from '@deepseek-ai/cordis'
/**
 * 宿主 cordis `Context` 的别名（本包 "declare module" 已在其上追加各市场服务键）。
 * 再导出一次是锚点留在 dts 产物里的机制，见上方注释。
 */
export type { CordisContext }

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

/**
 * 最新行情快照（公共数据，无需凭证）。
 *
 * **降级派生（2026-10-14）**：数据源的首选取价路径不可用时，连接器可用**同源序列**派生快照
 * （connector-eastmoney 即用当日分钟序列的末根收盘价 + 该序列自带的昨收与名称；2026-10-14
 * 实测其派生价与同刻腾讯报价逐位一致）。此时 `price` 是「最近一根分钟 bar 的收盘」而非逐笔
 * 最新价，滞后以该源的降级策略为界。派生值必须自洽——涨跌幅由同一对 `price`/`prevClose` 推出，
 * 名称与昨收取自同一响应；**拿不到的量宁可缺省**（`volume` 本就可选），不得用窗口合计之类的
 * 近似值冒充当日累计。降级不得掩盖「该标的确实不存在」：`TRADING_SYMBOL_NOT_FOUND` /
 * `TRADING_UNSUPPORTED_SYMBOL` 照实上报，消费方无需区分快照来自直取还是派生。
 */
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
  /** 预测（下一期）资金费率（小数；交易所未发布预测时缺省，issue #54）。 */
  readonly nextFundingRate?: number
  /** 下一期资金费率结算时间（epoch ms，GUI 倒计时用，issue #54）。 */
  readonly nextFundingTime?: number
  /** 标记价格（Mark Price，永续合约；issue #54 基差卡用）。 */
  readonly markPrice?: number
  /** 指数价格（Index Price，现货指数；与 markPrice 配对计算基差）。 */
  readonly indexPrice?: number
  /** 快照时间（epoch ms）。 */
  readonly timestamp: number
}

/** 衍生品时序数据点（资金费率历史 / OI 历史共用词汇，issue #54）。 */
export interface DerivativesPoint {
  /** 采样时间（epoch ms）。 */
  readonly time: number
  /** 采样值（费率序列为小数费率；OI 序列单位与快照 openInterest 同语义）。 */
  readonly value: number
}

/**
 * 衍生品历史序列（GUI「衍生品」页签趋势卡用，issue #54）：
 * 资金费率历史 + 未平仓量历史，时间一律升序（旧→新，与 K 线序列同向）。
 * 可选方法 getDerivativesHistory 的返回面；任一序列不可得时该字段缺省，
 * 消费方按卡降级（隐藏趋势图、保留快照读数）。
 */
export interface DerivativesHistory {
  /** 交易对符号，市场规范词汇（如 BTCUSDT-SWAP）。 */
  readonly symbol: string
  /** 数据来源（如 binance / okx）。 */
  readonly source: string
  /** 资金费率历史（时间升序，value 为小数费率）。 */
  readonly fundingRates?: DerivativesPoint[]
  /** OI 历史（时间升序，value 单位与 DerivativesData.openInterest 同语义）。 */
  readonly openInterest?: DerivativesPoint[]
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

/** 集合竞价快照与强弱基准（同花顺 A 股竞价数据面）。 */
export interface AuctionSnapshot {
  readonly symbol: string
  readonly matchPrice?: number
  readonly matchVolume?: number
  readonly unmatchedVolume?: number
  readonly unmatchedSide?: 'buy' | 'sell'
  readonly strengthIndex?: number
  readonly stage?: 'call' | 'final'
  readonly timestamp: number
}

/** 涨跌停池与连板天梯条目（同花顺特色短线数据面）。 */
export interface LimitUpPoolItem {
  readonly symbol: string
  readonly name: string
  readonly price: number
  readonly changePercent: number
  readonly limitType: 'up' | 'down' | 'broken'
  readonly firstLimitTime?: string
  readonly lastLimitTime?: string
  readonly limitOrderVolume?: number
  readonly limitOrderAmount?: number
  readonly consecutiveBoards?: number
  readonly breakCount?: number
  readonly sectorConcept?: string
}

/** 龙虎榜席位与机构明细条目（同花顺特色资金数据面）。 */
export interface DragonTigerItem {
  readonly symbol: string
  readonly name: string
  readonly closePrice: number
  readonly changePercent: number
  readonly reason: string
  readonly netBuyAmount: number
  readonly buyAmount: number
  readonly sellAmount: number
  readonly institutionalNetBuy?: number
  readonly topBrokers?: Array<{
    readonly rank: number
    readonly brokerName: string
    readonly type: 'buy' | 'sell'
    readonly buyAmount: number
    readonly sellAmount: number
    readonly isInstitutional: boolean
  }>
  readonly tradeDate: string
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
  readonly auction?: AuctionSnapshot
  readonly limitUpItem?: LimitUpPoolItem
  readonly dragonTiger?: DragonTigerItem
}

export type PositionSide = 'long' | 'short'

/**
 * 保证金模式（合约交易语义，P7）：`cross` = 全仓、`isolated` = 逐仓。
 * 现货（cash）不使用该字段——缺席即「非保证金/未设置」。
 */
export type MarginMode = 'cross' | 'isolated'

/** 持仓快照。 */
export interface Position {
  readonly symbol: string
  readonly side: PositionSide
  /** 仓位数量（正数；方向由 side 表达）。合约仓位是 **base 币数**（连接器已按合约乘数 ctVal 由张换算）。 */
  readonly size: number
  readonly entryPrice: number
  readonly markPrice?: number
  readonly unrealizedPnl?: number
  readonly leverage?: number
  /**
   * 强平价（交易所回传原样透传；交易所未提供或不适用时缺席，绝不本地推算强平价——
   * 强平口径与保证金模式、账户级保证金、维持保证金率有关，本地公式会给出错误的安全感）。
   */
  readonly liquidationPrice?: number
  /** 维持保证金率（OKX `mgnRatio`；口径由交易所定义，原样透传，不在本地换算或反推）。 */
  readonly marginRatio?: number
  /** 该仓位的保证金模式；现货持仓与交易所未提供时缺席。 */
  readonly marginMode?: MarginMode
  /** 名义价值（USD，交易所口径；用于敞口核对，不参与本地风控公式）。 */
  readonly notionalUsd?: number
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
  /** **base 币数量**：合约（永续）由连接器按合约乘数换算成张，消费方恒用币数语义。 */
  readonly quantity: number
  /** limit 单必填。 */
  readonly price?: number
  /**
   * 合约订单的保证金模式（缺省 `cross`）。仅对永续（`-SWAP`）有效：
   * 现货订单只允许 cash 语义，传该字段由连接器结构化拒绝
   * （现货逐仓/杠杆是另一个产品面，本仓未接线）。
   * `isolated` 需先在交易所侧设好该标的的逐仓杠杆（OKX `setLeverage`）。
   */
  readonly marginMode?: MarginMode
  /** 缺省/true 时仅模拟，不触碰交易所。实盘还受 @dshtrading/authority 的人工签署授权与 approval 约束 [S4]。 */
  readonly dryRun?: boolean
  /**
   * Stable caller-assigned idempotency id for this order intent.
   *
   * Required for live submissions (`dryRun: false`); a dry-run receipt may omit it.
   * Reusing the id with the same normalized request (same venue payload, provider,
   * environment and account) returns the recorded venue receipt instead of
   * submitting a second order; reusing it with a different payload, provider,
   * environment or account is rejected as a conflict and the request is never
   * silently re-parameterised. Only a venue receipt carrying a real non-empty
   * order id is recorded as confirmed — a timeout, storage failure or crash leaves
   * the intent unresolved and nothing is resubmitted automatically.
   *
   * The venue-facing client order key (`clOrdId` / `client_order_id` / `cOID` /
   * `remark` / `user_mark`) is derived from this id inside the connector and is
   * never surfaced: this id is the only handle callers pass in and read back.
   */
  readonly intentId?: string
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
 * 标的形态轴（2026-10-08 加密永续与 TradFi 永续落地）：与 `market` 正交，**不新增市场键**。
 * 缺省 = `spot`——已存自选、localStorage 与 iOS 冻结契约因此零迁移。
 *
 * 形态由规范符号后缀承载（`-SWAP` = 永续），见 docs/guides/symbol-vocabulary.md；
 * `form` 只出现在名册/检索/wire 元数据里，行情方法不新增 form 形参。
 */
export type InstrumentForm = 'spot' | 'perp'

/**
 * 标的资产类别标签（仅展示与检索排序用，不承载交易语义）。
 * **只信交易所元数据**（OKX `instCategory`、Binance `underlyingType`+`underlyingSubType`）；
 * 取不到时留空，禁止按符号字面猜（`SPX` 在 OKX 是迷因币 SPX6900，标普 500 是 `US500`）。
 */
export type InstrumentAssetClass = 'crypto' | 'equity' | 'commodity' | 'index'

/** 合约专有元数据（仅 `form=perp` 有值）：交易所元数据原样透传，不本地推断。 */
export interface InstrumentContract {
  /** 合约乘数（OKX ctVal / Binance contractSize）。 */
  readonly multiplier?: number
  /** 最小价格变动。 */
  readonly tickSize?: number
  /** 最小下单量/张数步长。 */
  readonly lotSize?: number
  /** 交易所允许的最大杠杆。 */
  readonly maxLeverage?: number
  /** 结算币种（如 USDT）。 */
  readonly settleCcy?: string
}

/**
 * 标的检索结果的最小元数据（名册/搜索/wire 共用）。
 * 元素形状对既有 `{ symbol, name? }` 实现向后兼容：`form`/`assetClass`/`contract` 全可选。
 */
export interface InstrumentRef {
  /** 市场规范词汇符号（docs/guides/symbol-vocabulary.md）。 */
  readonly symbol: string
  readonly name?: string
  /** 缺省 = spot（老数据零迁移）。 */
  readonly form?: InstrumentForm
  readonly assetClass?: InstrumentAssetClass
  readonly contract?: InstrumentContract
}

/** 港股通单日持股快照（东财 RPT_MUTUAL_STOCK_HOLDRANKS 口径）。 */
export interface SouthboundHoldingPoint {
  /** 交易日（UTC 当日 00:00 的 epoch ms；与日 K 的 openTime 同口径便于对齐）。 */
  readonly date: number
  /** 持股比例（百分比数值，如 11.9 表示 11.9%）。来源字段 HOLD_SHARES_RATIO（占港股已发行股本）。 */
  readonly holdRatio: number
  /** 持股数量（股）。 */
  readonly holdShares: number
  /** 持股市值（HKD）。 */
  readonly holdMarketCap: number
}

/** 港股通持股历史（按交易日升序，旧→新，已按日去重）。 */
export interface SouthboundHoldingHistory {
  /** 市场规范词汇 symbol（如 00700.HK）。 */
  readonly symbol: string
  /** 序列升序；同一交易日至多一条。标的不在港股通范围时为空数组（不是抛错）。 */
  readonly points: readonly SouthboundHoldingPoint[]
}

/**
 * 当日累计主动买盘快照（cn 行情行盘口推断口径，2026-10-13）。
 *
 * **口径**：`outerLots`/`innerLots` 是行情源按「成交价对盘口的主动方向」推断的当日累计
 * 外盘/内盘（外盘 = 主动买、内盘 = 主动卖），**不是交易所官方逐笔方向**；涨跌停一字板与
 * 对倒（自成交）交易日读数会系统性失真。占比一律按「÷当日总量」口径。
 * `totalLots` 与 `outerLots + innerLots` 存在残差（未归向成交：集合竞价与价间成交计入总量
 * 但不计入外/内盘），实测 2026-10-13 为 002714 12/121808 手（0.0099%）、600519
 * 45/7154 手（0.629%）——残差**不是**固定量级，且**不据它修正读数**，源读数原样返回。
 */
export interface ActiveBuySnapshot {
  /** 市场规范词汇 symbol（如 002714.SZ）。 */
  readonly symbol: string
  /** 快照所属交易日 `YYYY-MM-DD`（源字段 30，交易所本地墙钟）。 */
  readonly date: string
  /** 快照时刻 `HH:MM:SS`（源字段 30，交易所本地墙钟）。 */
  readonly time: string
  /** 当日累计总量（手）。 */
  readonly totalLots: number
  /** 当日累计外盘 = 主动买（手）。 */
  readonly outerLots: number
  /** 当日累计内盘 = 主动卖（手）。 */
  readonly innerLots: number
  /** 主动买占比 `outer/total*100`（2 位小数）。 */
  readonly buySharePct: number
  /** 净主动买占比 `(outer-inner)/total*100`（2 位小数，负值 = 净主动卖）。 */
  readonly netSharePct: number
  /** 涨停价（源字段 47；指数/ETF 等无涨跌停的标的不带此字段）。 */
  readonly limitUp?: number
  /** 跌停价（源字段 48；同上缺省）。 */
  readonly limitDown?: number
  /** 数据源标识（如 'qt.gtimg.cn'）。 */
  readonly source: string
  /** 取数时刻，ISO 8601 带偏移（交易所本地墙钟，如 2026-10-13T09:53:12+08:00）。 */
  readonly fetchedAt: string
}

/**
 * 连接器自我申报的 K 线能力（2026-10-15 跨源 K 线路由）：对自己**能诚实服务**的
 * (周期, 请求深度) 的声明。深度必须来自本连接器自己的实证，不借别家的数字。
 *
 * `maxBars` 是该周期能承接的 `limit` 上限，**不是返回根数保证**：
 *   - `limit <= maxBars`：请求在本源自己的语义下已被诚实服务——返回根数以本源自己的
 *     取数窗口/上游上限为界（如窗口型源的 5 个交易日），但不得因为请求更大而静默降级
 *     到更小的窗口或更浅的历史；
 *   - `limit > maxBars`：本源结构性不足——上游会静默截到更少根数、忽略该参数，
 *     或根本没有该周期的通道。
 *
 * 方法缺席 = **未声明**，不是「不支持」：消费方照旧可直接调用，错误码才是判据。
 */
export interface KlineCapability {
  readonly interval: Interval
  readonly maxBars: number
}

/**
 * 行情服务契约：由市场连接器实现，注册到按市场命名空间的 ctx 键（如 ctx.tradingCrypto）。
 * 符号词汇（2026-08-31 规范，docs/guides/symbol-vocabulary.md）：入参接受市场规范形与连接器原生形，
 * 输出 `symbol` 一律市场规范形——消费方（GUI/Agent/工作流）与数据源方言解耦。
 */
export interface MarketDataService {
  getTicker(symbol: string): Promise<Ticker>
  getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]>
  /**
   * K 线能力声明（可选，2026-10-15 跨源 K 线路由；语义见 KlineCapability）：本源能诚实
   * 服务的 (周期, 请求深度) 清单。桥据它做跨源解析——active 覆盖请求就用 active，只有
   * active 结构性不足时才换同市场其它已注册源——并把同市场全部注册项的并集上报客户端。
   * 可选方法：未声明的连接器缺席，桥退回「按 TRADING_UNSUPPORTED_INTERVAL 错误码兜底」
   * 路径（行为与不声明前一致）。
   */
  klineCapabilities?(): readonly KlineCapability[]
  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void): Disposable
  /**
   * 批量最新报价（GUI 自选/盘中列表每拍取价用，2026-10-14）：一次请求取多只标的，
   * 免掉「N 只标的 N 次请求」。键**必须是入参里的原字符串**（调用方按它一一对应），
   * 值为该标的的行情快照（`Ticker.symbol` 仍是市场规范形）。
   *
   * 语义约定（调用方与实现共同遵守）：
   *   - 只返回**确实拿到**的标的：未收录/无法解析的符号不出现在结果里，由调用方回落
   *     到 `getTicker` 单取（保住各符号自己的错误码），故实现**不得**为凑齐入参造假行；
   *   - 整批取数失败（网络/上游故障）**应抛出**，调用方按整批失败上报，不做 N 次重试；
   *   - 单次请求的标的数由调用方裁剪（桥侧 MAX_SYMBOLS），实现无需自行分片。
   *
   * 可选方法：数据源无原生批量端点的市场不实现，调用方自动回落逐只 `getTicker`。
   */
  getTickers?(symbols: string[]): Promise<Record<string, Ticker>>
  /**
   * 查询本市场/交易所支持的全部标的名册（动态全集，Issue #15）。
   * 输出 `symbol` 一律市场规范词汇（docs/guides/symbol-vocabulary.md），形态由符号后缀承载
   * （`-SWAP` = 永续，`instrumentFormOf` 是唯一裁决实现）；每行可带
   * `form`/`assetClass`/`contract` 元数据（InstrumentRef），缺省 = 现货。
   * 可选方法：无公开全集端点的数据源（如 tencent/yahoo/stooq）可缺省或由桥/前端回退。
   */
  listInstruments?(): Promise<InstrumentRef[]>
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
   * 衍生品历史序列（GUI「衍生品」页签趋势卡用，issue #54）：资金费率历史 +
   * OI 历史，时间升序。可选方法：无公开历史端点的数据源不实现；未实现或失败
   * 时消费方隐藏趋势图、保留快照读数（与快照同族的降级纪律）。
   * 入参接受规范形与连接器原生形，输出 symbol 一律规范词汇 SWAP 形。
   */
  getDerivativesHistory?(symbol: string): Promise<DerivativesHistory>
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
  /**
   * 港股通持股历史（GUI「港股通持股比例」副图用，2026-10-13）：日频序列，
   * 升序、按交易日去重。可选方法：无该数据端点的数据源不实现（当前仅
   * connector-eastmoney 的 hk 实例实现）；标的不在港股通范围时返回空 points
   * （**空 ≠ 0**，消费方隐藏副图而非画零线），上游失败则抛错。
   * 入参接受规范形与连接器原生形，输出 `symbol` 一律市场规范词汇。
   */
  getSouthboundHoldings?(symbol: string): Promise<SouthboundHoldingHistory>
  /**
   * 当日累计主动买盘快照（外盘/内盘/买占比/净买占比，cn 专用，2026-10-13）。
   * 可选方法：仅 cn 数据源实现（腾讯行情行的盘口推断口径，**非交易所官方逐笔方向**）；
   * 涨跌停一字板与对倒交易日读数失真。hk 等无该字段的市场**方法缺席**——消费方据此
   * 降级（隐藏该面板），**不回退成 0**：缺席表示「无此读数」，不是「主动买为 0」。
   * 读数非法（总量 <= 0、外盘/内盘字段缺失或非有限）时抛 TRADING_EXCHANGE_ERROR，
   * 绝不补 0、绝不返回 NaN。
   * 入参接受规范形与连接器原生形，输出 `symbol` 一律市场规范词汇。
   */
  getActiveBuySnapshot?(symbol: string): Promise<ActiveBuySnapshot>
}

/**
 * 杠杆设置请求（合约交易语义，P7；仅 `form=perp` 的标的可传）。
 * dryRun 缺省视为 true：只回本地模拟回执，不触碰交易所（与 placeOrder 同语义）。
 */
export interface SetLeverageRequest {
  readonly symbol: string
  /** 目标杠杆倍数（> 0；上限以交易所规格 `InstrumentContract.maxLeverage` 为准，超出即结构化拒绝）。 */
  readonly leverage: number
  readonly marginMode: MarginMode
  /** 双向持仓模式下的方向（OKX `posSide`）；净持仓模式下缺席。 */
  readonly posSide?: 'long' | 'short'
  /** 全仓模式下按币种设置杠杆时的保证金币（OKX `ccy`）；逐仓与净持仓模式缺席。 */
  readonly ccy?: string
  /** 缺省/true 时仅模拟。实盘还受 @dshtrading/authority 的人工签署授权与 approval 约束 [S4]。 */
  readonly dryRun?: boolean
}

/** 杠杆设置回执（dryRun=true 时是本地模拟回执，不触网）。 */
export interface LeverageSetting {
  readonly symbol: string
  readonly leverage: number
  readonly marginMode: MarginMode
  readonly posSide?: 'long' | 'short'
  readonly ccy?: string
  /** 本次是否为模拟回执（回执必须显式回带，防 dry-run 语义丢失）。 */
  readonly dryRun: boolean
  readonly timestamp: number
}

/**
 * 交易服务契约：placeOrder 默认 dry-run；实盘前必须过 @dshtrading/authority 的人工签署授权与
 * ctx.approval.request（交互形态；headless 下 ask=deny，fail-closed [S4]）。
 *
 * R3（okx 切片 2026-08-29）修订：cancelOrder 增加可选 symbol、新增 getOrder——
 * OKX 按 (instId, ordId) 双键定位订单，单参 id 形态不够；无其他实现方，扩展向后兼容。
 *
 * P7（合约交易 Tier 2，2026-10-08）修订：新增可选 `setLeverage`——杠杆/保证金模式变更
 * 是实盘动作，必须与下单同门槛（服务缝三态闸门 + base 审批闸门 + 人工签署授权）。
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
  /**
   * 设置合约杠杆与保证金模式（P7 合约交易 Tier 2；仅支持合约的交易所实现）。
   * 可选方法：不实现的连接器缺席即可，消费方按 TRADING_NOT_IMPLEMENTED 语义处理。
   * 这是会改变账户真实风险参数的实盘动作：dryRun 缺省 true（只回本地模拟回执），
   * dryRun=false 必须同时具备人工签署的实盘授权，并经 base 审批闸门。
   */
  setLeverage?(req: SetLeverageRequest): Promise<LeverageSetting>
}

/**
 * 统一错误词汇（本包不做运行时 Error 类；实现方自行映射到该词汇）。
 * 命名空间 `TRADING_`，跨市场/跨连接器稳定。
 */
export type TradingErrorCode =
  /** 功能未实现（骨架/占位阶段）；工具层语义：可选方法缺席 ≠ 无数据。 */
  | 'TRADING_NOT_IMPLEMENTED'
  /** 该市场无激活的数据/交易 provider（路由未选或连接器未注册/未激活）。 */
  | 'TRADING_NO_PROVIDER'
  /** 该市场未注册任何交易连接器（无账户/交易能力；与 NO_PROVIDER 区分）。 */
  | 'TRADING_NO_TRADE_SERVICE'
  /** 该市场注册了交易连接器，但路由选中的数据 provider 没有交易面（需设 tradeProvider；≠ 未安装）。 */
  | 'TRADING_TRADE_PROVIDER_NOT_ROUTED'
  | 'TRADING_UNSUPPORTED_SYMBOL'
  | 'TRADING_UNSUPPORTED_INTERVAL'
  /**
   * 请求到达了上游、上游答了，但没有这个标的（HTTP 404、400 + `label` 以 `INVALID_` 开头，
   * 或 200 但没有任何可用行）——与 `TRADING_UNSUPPORTED_SYMBOL`（本地就判定这个形态不支持、
   * 零请求）区分：这里是「上游说查不到」，消费方不该当基础设施抖动去重试。
   * 8 个连接器已按此语义实际使用该码（akshare / eastmoney / finnhub / fmp / longbridge /
   * polygon / tushare / ccxt 的行级判空与 404 映射），此前只是漏进了本词汇表（类型层缺口，
   * 与 `TRADING_UPSTREAM_ERROR` 曾经的缺口同形）。
   */
  | 'TRADING_SYMBOL_NOT_FOUND'
  /** 凭证缺失或无效（ctx.credentials 引用解析失败 [S4]）。 */
  | 'TRADING_CREDENTIALS_MISSING'
  | 'TRADING_AUTH_FAILED'
  | 'TRADING_RATE_LIMITED'
  | 'TRADING_NETWORK'
  /**
   * 上游返回了非成功状态（HTTP 4xx/5xx 或上游业务错误码）——与 TRADING_NETWORK
   * （连不上/超时）区分：请求到达了上游，上游明确报错。13 个连接器已按此语义使用
   * 该码（rest.ts 的 HTTP 非 ok 分支），此前只是漏进了本词汇表（类型层缺口）。
   */
  | 'TRADING_UPSTREAM_ERROR'
  | 'TRADING_INSUFFICIENT_BALANCE'
  /** 未获人工签署实盘授权时拒绝实盘（铁律 #3）。 */
  | 'TRADING_LIVE_TRADING_DISABLED'
  /**
   * 请求缺一个**必填**的账户定位（当前用点：桥的 `cancel-order` 必须显式 `accId`——
   * 请求里没有 market，HK / US 是两套 trd 上下文，桥不猜）。
   * 与 TRADING_EXCHANGE_ERROR 分开：上游对同类缺格回的是它自己那句错误串，读起来像
   * "venue 拒绝了这笔单"，而事实是**我们发错了请求**（客户端手里本来就有全部信息）。
   */
  | 'TRADING_ACCOUNT_REQUIRED'
  /** approval 被拒/无应答（headless fail-closed [S4]）。 */
  | 'TRADING_APPROVAL_DENIED'
  /** 本次为 dry-run 模拟结果（非故障语义）。 */
  | 'TRADING_DRY_RUN'
  /** Order intents（实盘幂等台账）：实盘请求缺稳定 `intentId`（dry-run 可缺省）。 */
  | 'TRADING_INTENT_REQUIRED'
  /** Order intents：同一 `intentId` 已被不同规范载荷/provider/环境/账户占用——拒绝，不自动改参数。 */
  | 'TRADING_INTENT_CONFLICT'
  /**
   * Order intents：该 `intentId` 已有持久记录（已提交或结局未知）而**尚无** venue 回执。
   * 明确告知「未知/在飞」，绝不自动重发；推进只能靠人工或读对账。
   */
  | 'TRADING_INTENT_UNKNOWN'
  /** Order intents：台账写盘失败——本次不调用 venue（宁可不发，也不发一笔没有持久记录的实盘单）。 */
  | 'TRADING_INTENT_STORE_FAILED'
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
    /** futures 市场行情服务（由同花顺期货连接器提供，issue #97；日K + 当日分时聚合）。 */
    tradingFuturesMarketData: MarketDataService
    /** 全球品种行情（global 市场：大宗/外汇/海外指数；@dshtrading/connector-jin10 dataplane 行提供）。 */
    tradingGlobalMarketData: MarketDataService
    /**
     * crypto 市场交易服务（R3 2026-08-29 补齐，crypto 市场第一个真实 TradeService）：
     * 由 connector-okx 实现（签名 demo/live 下单），与 connector-binance 经
     * Config.enabled 互斥激活同一 tradingCryptoMarketData 键时一并 provide。
     */
    tradingCryptoTrade: TradeService
    /**
     * 交易服务注册表（issue #40 GUI 交易台，@dshtrading/api 类型声明）：
     * 与 tradingMarketDataRegistry 同构的宿主平面注册面——交易连接器 host 面数据行
     * 注册，GUI 桥按路由当前值惰性解析。**注册不改变安全语义**：placeOrder 的
     * 服务缝闸门（dryRun 缺省 true + @dshtrading/authority 人工签署授权）随服务实例生效；
     * GUI 桥只放行 dry-run 下单与只读查询，实盘路径仍走 Agent 工具的 base 审批闸门。
     */
    tradingTradeRegistry: TradeRegistry
    /**
     * 市场路由服务（R5 2026-08-29 补齐，@dshtrading/router 提供）：
     * 连接器 apply 时 consult activeProvider(market) 决定是否激活——用户设置
     * dshtrading.markets.<market>.provider 选谁谁激活（docs/exchange-routing.md）。
     */
    tradingMarketRouter: MarketRouterService
    /**
     * 行情服务注册表（2026-08-30 注册表模式定稿，@dshtrading/router 同插件提供）：
     * 连接器 host 面数据行注册，GUI 行情桥按路由当前值惰性解析（热切换）。
     */
    tradingMarketDataRegistry: MarketDataRegistry
    /**
     * 新闻聚合器注册表（Issue #37，@dshtrading/router 同插件提供）：
     * 各市场 Kit apply 时注册 aggregateNews 纯函数，GUI 行情桥按市场获取。
     */
    tradingNewsRegistry: TradingNewsRegistry
    /** 跨市场快讯源（@dshtrading/connector-jin10 提供；缺席 = 未安装快讯连接器）。 */
    tradingFlashFeed: FlashFeedService
    /** 宏观/利率源（@dshtrading/connector-jin10 提供；缺席 = 未安装金十连接器）。 */
    tradingMacroFeed: MacroFeedService
    /** 预测市场源（@dshtrading/connector-polymarket 提供；缺席 = 未安装预测市场连接器）。 */
    tradingPredictionFeed: PredictionFeedService
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

/* ── 新闻聚合契约（Issue #37）──────────────────────────────── */

/** 新闻/快讯条目（各市场 Kit 统一输出形状）。 */
export interface NewsItem {
  /** 来源标识（如 'eastmoney'、'yahoo'、'googlenews'、'binance'、'coindesk' 等）。 */
  readonly source: string
  /** 新闻/快讯标题。 */
  readonly title: string
  /** 详情页 URL。 */
  readonly url: string
  /** ISO 8601 发布时间。 */
  readonly publishedAt: string
  /** 关联标的代码（可选，格式随源不同）。 */
  readonly relatedCodes?: readonly string[]
  /** 热度等级（可选；金十快讯网页版 火/热/沸/爆，其他源不填）。 */
  readonly hot?: string
}

/** 新闻聚合请求选项。 */
export interface AggregateNewsOptions {
  /** 输出条数上限（1~50，默认 20）。 */
  limit?: number | undefined
  /** 时间窗口（小时，1~168，默认 24）。 */
  windowHours?: number | undefined
  /** 按标的代码过滤（可选）。 */
  symbol?: string | undefined
  /** CryptoPanic API token（仅 crypto 市场使用，可选）。 */
  cryptoPanicKey?: string | undefined
  /**
   * 启用的新闻/公告源 id 列表（issue #96 源配置化；各 kit 的 NewsSource 词汇）。
   * 缺省 = 该市场全部默认源；空数组 = 显式关闭（返回空结果）。
   */
  sources?: readonly string[] | undefined
}

/** 新闻聚合结果。 */
export interface AggregateNewsResult {
  /** 按发布时间倒序的新闻条目。 */
  readonly items: readonly NewsItem[]
  /** 失败的数据源名称（fail-soft 容错：可用源正常返回，不可用源记录在此）。 */
  readonly unavailable: readonly string[]
}

/** 新闻聚合器函数签名（各 Kit 导出的 aggregateNews 符合此形状）。 */
export type NewsAggregator = (options?: AggregateNewsOptions) => Promise<AggregateNewsResult>

/**
 * 跨市场快讯源契约（2026-09-13 金十接入）：host 平面由快讯连接器 provide
 * tradingFlashFeed，GUI 快讯面板（桥 /dshtrading/api/flash）与 agent 快讯工具
 * 共用同一取数实现；服务缺席 = 未安装/未启用该数据源 → 消费方报
 * TRADING_NOT_IMPLEMENTED，绝不把「没有数据源」伪装成「没有快讯」。
 */
export interface FlashFeedService {
  /**
   * 最新快讯流（cursor 翻页）；条目只含元数据（标题/时间/链接）。
   * `hot` 非空时按热度等级服务端过滤（金十网页版 火/热/沸/爆）。
   */
  listFlash(options?: { cursor?: string | undefined; limit?: number | undefined; hot?: readonly string[] | undefined }): Promise<{
    readonly items: readonly NewsItem[]
    readonly nextCursor?: string | undefined
    readonly hasMore: boolean
  }>
  /** 关键词搜快讯（上游一次性返回、不支持翻页）。 */
  searchFlash(keyword: string, limit?: number | undefined): Promise<readonly NewsItem[]>
}

/**
 * 宏观经济日历条目（金十当周经济数据，2026-09-15）：数值均为上游快照原样字符串，
 * `actual` 缺省 = 未公布。
 */
export interface MacroCalendarEntry {
  /** ISO 8601 公布时间（东八区解释，同 NewsItem 口径）。 */
  readonly publishedAt: string
  /** 重要度（上游 star，0–5）。 */
  readonly star: number
  /** 地区（标题前缀推断，如 美国/日本/中国；未识别 = 空串）。 */
  readonly region: string
  readonly title: string
  readonly previous?: string
  readonly consensus?: string
  readonly actual?: string
  readonly revised?: string
  /** 上游公布影响词（利多/利空/影响较小…；原样透传）。 */
  readonly affect?: string
}

/** 央行最新利率条目（金十网页版，2026-09-15）。 */
export interface MacroRateEntry {
  /** 地区（flag 名推断，如 美国/日本/中国；未识别 = 空串）。 */
  readonly region: string
  readonly bankName: string
  /** 最新利率（上游原样字符串，如 "3.75"/"0"）。 */
  readonly rate: string
  /** 公布日（上游原样 YYYY-MM-DD）。 */
  readonly publishedAt: string
  /** 所属指标名（如「美联储利率决定(上限)」；部分央行缺省）。 */
  readonly indicatorName?: string
}

/**
 * 宏观/利率源契约（2026-09-15 金十接入）：host 平面由金十连接器 provide
 * tradingMacroFeed，GUI 宏观面板（桥 /dshtrading/api/macro/*）消费；服务缺席 =
 * 未安装/未启用该数据源 → 消费方报 TRADING_NOT_IMPLEMENTED，绝不把「没有数据源」
 * 伪装成「没有数据」。日历走官方 MCP（list_calendar），利率走网页版公开接口
 * （spikes/impl-jin10-macro-rates/EVIDENCE.md）。
 */
export interface MacroFeedService {
  /** 当周经济日历（周一~周日，北京时间；limit 截尾，缺省全周）。 */
  listCalendar(limit?: number | undefined): Promise<readonly MacroCalendarEntry[]>
  /** 央行最新利率（全量，客户端按地区过滤）。 */
  listRates(): Promise<readonly MacroRateEntry[]>
}

/**
 * 预测市场档位条目（2026-10-11 Polymarket 接入）。
 *
 * 标签与概率均来自上游 `groupItemTitle` / `outcomePrices[0]`；`key` 是归一化后的
 * 稳定档位标识（上游标签在大小写与 `+` 上会漂移——实测 `No change` / `No Change`、
 * `50+ bps decrease` / `50 bps decrease` 并存，按原文匹配会随会议换 slug 静默失效）。
 */
export interface PredictionOutcomeBucket {
  /** 稳定档位键（如 `no_change` / `inc_25` / `dec_50plus`；未识别形态 = `raw:<原文>`）。 */
  readonly key: string
  /** 上游档位标签原文（展示用，不做改写）。 */
  readonly label: string
  /** 对应利率变动（bps；降息为负）。未识别形态 = undefined（不猜）。 */
  readonly changeBps?: number | undefined
  /** 隐含概率 = 上游 `outcomePrices[0]`（gamma 与 CLOB midpoint 实测 15/15 完全相等）。 */
  readonly probability: number
  /** 最优买价（结算后上游为 null → 缺省）。 */
  readonly bestBid?: number | undefined
  /** 最优卖价。 */
  readonly bestAsk?: number | undefined
  /** 价差（bestAsk − bestBid；任一端缺失则缺省）。 */
  readonly spread?: number | undefined
  /** 盘口深度（上游 `liquidityNum`，美元）。 */
  readonly liquidity?: number | undefined
  /** 累计成交额（上游 `volumeNum`，美元）。 */
  readonly volume?: number | undefined
  /** 24 小时成交额（上游 `volume24hr`，美元）。 */
  readonly volume24h?: number | undefined
  /** 最小报价粒度（上游 `orderPriceMinTickSize`）。 */
  readonly tickSize?: number | undefined
  /**
   * 回填取数定位键（上游 gamma market `clobTokenIds[0]`，公开数据非凭据；客户端不消费）。
   * 历史价格按 token 扇出（CLOB `prices-history` 只认 token），客户端拿到的是
   * 按事件窗口聚合好的序列，不需要这个键。
   */
  readonly clobTokenId?: string | undefined
  /**
   * 是否仍可下单（上游 market 级 `acceptingOrders`）。**不用 `active` 判断**：
   * 实测结算后 `active` 仍为 true，只有 `closed`/`acceptingOrders` 会翻转。
   */
  readonly acceptingOrders: boolean
  /** 该档位市场是否已结算（上游 market 级 `closed`）。 */
  readonly closed: boolean
  /** 与最近一条本地快照的差值（无快照/首次采样 = undefined，绝不填 0 冒充无变动）。 */
  readonly changeSincePrevious?: number | undefined
}

/** 一场 FOMC 决议会议（会议时间 + 档位集合 + 健康标记）。 */
export interface PredictionMeeting {
  /** 上游 event id（去重键；slug 带随机后缀，不可作标识）。 */
  readonly id: string
  readonly slug: string
  readonly title: string
  /** 决议结果窗口结束（上游 event `endDate`，ISO 8601 UTC）。 */
  readonly endDate: string
  /** FOMC 会议日程（从上游 description 解析，如 `October 27-28, 2026`；未解析到 = 缺省）。 */
  readonly meetingWindow?: string | undefined
  readonly closed: boolean
  /** 档位集合，按利率变动从低到高排序（未知形态排末位）。 */
  readonly buckets: readonly PredictionOutcomeBucket[]
  /** 各档概率之和（健康检查；实测正常区间约 [0.98, 1.03]，不假设严格等于 1）。 */
  readonly probabilitySum: number
  /**
   * 数据质量提示（空 = 全部健康）。桥与面板只做展示，不据此改写概率。
   * 例：`probability-sum-out-of-band`、`probability-out-of-range`、`bucket-quote-missing`、
   * `bucket-unrecognized-label`。
   */
  readonly degraded: readonly string[]
}

/**
 * 预测市场快照（一次取数的完整结果）。
 *
 * `fetchedAt` 是**本进程的取数时刻**——上游只给 `updatedAt` 级别的事件时间，
 * 没有响应级时间戳，所以数据时间戳由取数侧记录（单调可信）。
 */
export interface PredictionFeed {
  /** 取数时刻（ISO 8601 UTC；数据时间戳的唯一来源）。 */
  readonly fetchedAt: string
  readonly meetings: readonly PredictionMeeting[]
}

/** 一条服务端历史价格读数（CLOB prices-history 的 t/p 原样，不换算单位）。 */
export interface PredictionPricePoint {
  /** 上游时间戳（unix 秒）。 */
  readonly t: number
  /** 上游价格（midpoint 口径 0..1，与 gamma outcomePrices 等价）。 */
  readonly p: number
}

/** 单档在请求窗口内的历史序列。 */
export interface PredictionPriceSeries {
  readonly bucketKey: string
  readonly points: readonly PredictionPricePoint[]
}

/** 一段请求窗口的历史结果（服务端解析 token 后扇出各档）。 */
export interface PredictionPriceHistory {
  /** 取数时刻（ISO 8601 UTC）。 */
  readonly fetchedAt: string
  /** 上游 event id。 */
  readonly meetingId: string
  /** 请求窗口（epoch ms，原样回述以便客户端复算）。 */
  readonly fromMs: number
  readonly toMs: number
  /** 请求粒度（分钟）。 */
  readonly fidelityMinutes: number
  readonly series: readonly PredictionPriceSeries[]
}

/** 历史请求（窗口上限 336 小时 = 上游 startTs/endTs 实测边界）。 */
export interface PredictionPriceHistoryRequest {
  readonly meetingId: string
  readonly fromMs: number
  readonly toMs: number
  readonly fidelityMinutes?: number | undefined
}

/**
 * 预测市场源契约（2026-10-11 Polymarket 接入，v1 只覆盖 FOMC 决议路径）：
 * host 平面由 connector-polymarket provide `tradingPredictionFeed`，GUI 面板经桥
 * `/dshtrading/api/prediction/*` 消费；服务缺席 = 未安装/未启用该数据源 →
 * 消费方报 TRADING_NOT_IMPLEMENTED，绝不把「没有数据源」伪装成「没有数据」。
 *
 * 发现规则与概率口径以 spikes/impl-polymarket/EVIDENCE.md 为唯一判据：
 * `GET /events?series_id=35` → 系列校验 → 标题正则 → 形状 → 噪声排除 → 去重/排序；
 * 概率取 gamma `outcomePrices[0]`（与 CLOB midpoint 数值等价，单请求可取全量）。
 */
export interface PredictionFeedService {
  /** 当前 FOMC 决议路径全部会议（含已结算；按 endDate 升序）。 */
  listFomcMeetings(): Promise<PredictionFeed>
  /**
   * 单场会议在请求窗口内的逐档概率历史（2026-10-15 事件窗口回填）。
   *
   * 失败必须响亮：服务缺席/上游失败/窗口超限各自以可区分的错误抛出——**不得**
   * 以空 series 冒充「上游没有变动」（真无变动与取数失败在客户端是两个结论）。
   */
  listPriceHistory(request: PredictionPriceHistoryRequest): Promise<PredictionPriceHistory>
}

/** 新闻聚合器注册表契约（Issue #37，router 插件提供）。 */
export interface TradingNewsRegistry {
  register(market: string, aggregator: NewsAggregator): () => void
  get(market: string): NewsAggregator | undefined
  markets(): string[]
}

// 定时任务协议与 cron 引擎（2026-10-01 P1 三平面拆包时从 client-ui-trading 的
// src/client/ 搬来）：两者本身就是**契约**——GUI 与宿主两侧都要按同一份封套解析、
// 按同一份 cron 语义算下次触发；放在纯契约包里，bot 平面才不必反向依赖 GUI 包。
export * from './tasks-protocol.ts'
export * from './tasks-schedule.ts'
// 形态词汇裁决（同上：契约本身，不是业务实现）。`-SWAP` 后缀 = 永续是这个包的事实。
export * from './instrument-form.ts'
