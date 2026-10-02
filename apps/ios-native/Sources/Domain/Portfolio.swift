//
//  Portfolio.swift
//  Domain
//
//  持仓 / 成交 / 资产 / 资金变动。
//
//  一条贯穿本文件的区分：**账户级数字 != 机器人级数字**。
//  账户可能由多个机器人共用（还可能混着手动单），所以两者是**不同类型**，
//  从账户数字到机器人数字必须经过显式的归属判定（见 Attribution.swift）。
//

import Foundation

/// 账户级持仓。来源是账户同步，**不一定属于某一个机器人**。
public struct AccountPosition: Hashable, Sendable {
    public let account: AccountRef
    public let symbol: String
    public let quantity: Decimal
    public let averageCost: Decimal?
    public let markPrice: Decimal?
    public let unrealizedPnl: Decimal?

    public init(account: AccountRef, symbol: String, quantity: Decimal, averageCost: Decimal?, markPrice: Decimal?, unrealizedPnl: Decimal?) {
        self.account = account
        self.symbol = symbol
        self.quantity = quantity
        self.averageCost = averageCost
        self.markPrice = markPrice
        self.unrealizedPnl = unrealizedPnl
    }
}

/// 机器人级持仓。**只有归属可靠时才有数字**（由归属层产出）。
public struct BotPosition: Hashable, Sendable {
    public let botId: BotId
    public let runId: RunInstanceId?
    public let symbol: String
    public let quantity: Decimal
    public let averageCost: Decimal?
    public let markPrice: Decimal?
    public let unrealizedPnl: Decimal?

    public init(botId: BotId, runId: RunInstanceId?, symbol: String, quantity: Decimal, averageCost: Decimal?, markPrice: Decimal?, unrealizedPnl: Decimal?) {
        self.botId = botId
        self.runId = runId
        self.symbol = symbol
        self.quantity = quantity
        self.averageCost = averageCost
        self.markPrice = markPrice
        self.unrealizedPnl = unrealizedPnl
    }
}

/// 一笔成交。估值**必须用交易所回报的成交价**（不得用本地 tick）。
public struct Fill: Hashable, Sendable {
    public let fillId: FillId
    public let orderId: OrderId
    public let botId: BotId
    public let runId: RunInstanceId?
    public let symbol: String
    public let side: OrderSide
    public let quantity: Decimal
    public let price: Decimal
    public let fee: Decimal
    public let feeCurrency: String
    public let tradedAtMs: EpochMillis
    public let venueTradeId: String?

    public init(
        fillId: FillId,
        orderId: OrderId,
        botId: BotId,
        runId: RunInstanceId?,
        symbol: String,
        side: OrderSide,
        quantity: Decimal,
        price: Decimal,
        fee: Decimal,
        feeCurrency: String,
        tradedAtMs: EpochMillis,
        venueTradeId: String?
    ) {
        self.fillId = fillId
        self.orderId = orderId
        self.botId = botId
        self.runId = runId
        self.symbol = symbol
        self.side = side
        self.quantity = quantity
        self.price = price
        self.fee = fee
        self.feeCurrency = feeCurrency
        self.tradedAtMs = tradedAtMs
        self.venueTradeId = venueTradeId
    }
}

/// 单个币种余额。
public struct AssetBalance: Hashable, Sendable {
    public let currency: String
    public let total: Decimal
    public let available: Decimal
    public let locked: Decimal

    public init(currency: String, total: Decimal, available: Decimal, locked: Decimal) {
        self.currency = currency
        self.total = total
        self.available = available
        self.locked = locked
    }
}

/// 账户资产快照。
public struct AccountAssetSnapshot: Hashable, Sendable {
    public let account: AccountRef
    public let atMs: EpochMillis
    public let balances: [AssetBalance]

    public init(account: AccountRef, atMs: EpochMillis, balances: [AssetBalance]) {
        self.account = account
        self.atMs = atMs
        self.balances = balances
    }
}

/// 资金变动类型。未知值由 ClosedEnum 承载 ⇒ 不作为已识别语义使用。
public enum CashMovementKind: String, ClosedEnumValue, CaseIterable, Sendable {
    case deposit
    case withdrawal
    case fee
    case funding
    case realizedPnl = "realized_pnl"
    case transfer
    case adjustment
}

/// 一笔资金变动。botId 为 nil ⇒ 归属不明（**如实标注，不硬塞给某个机器人**）。
public struct CashMovement: Hashable, Sendable {
    public let movementId: CashMovementId
    public let account: AccountRef
    public let atMs: EpochMillis
    public let kind: ClosedEnum<CashMovementKind>
    public let amount: Decimal
    public let currency: String
    public let orderId: OrderId?
    public let fillId: FillId?
    public let botId: BotId?

    public init(
        movementId: CashMovementId,
        account: AccountRef,
        atMs: EpochMillis,
        kind: ClosedEnum<CashMovementKind>,
        amount: Decimal,
        currency: String,
        orderId: OrderId?,
        fillId: FillId?,
        botId: BotId?
    ) {
        self.movementId = movementId
        self.account = account
        self.atMs = atMs
        self.kind = kind
        self.amount = amount
        self.currency = currency
        self.orderId = orderId
        self.fillId = fillId
        self.botId = botId
    }

    /// 能否记到某个机器人头上：只有 explicit 的 botId 才算。
    public var attributedBot: BotId? { botId }
}
