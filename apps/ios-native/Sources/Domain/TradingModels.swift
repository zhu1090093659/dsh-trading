import Foundation

public struct BotID: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
}
public struct RunID: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
}
public struct StrategyVersion: Hashable, Codable, Sendable {
    public let strategyID: String
    public let version: String
    public init(strategyID: String, version: String) { self.strategyID = strategyID; self.version = version }
}
public struct BotRun: Hashable, Codable, Sendable {
    public let botID: BotID
    public let strategy: StrategyVersion
    public let runID: RunID
    public init(botID: BotID, strategy: StrategyVersion, runID: RunID) {
        self.botID = botID; self.strategy = strategy; self.runID = runID
    }
}
public struct Robot: Equatable, Sendable {
    public let id: BotID
    public let name: String
    public let strategy: StrategyVersion
    public let currentRun: BotRun?
    public init(id: BotID, name: String, strategy: StrategyVersion, currentRun: BotRun?) throws {
        guard currentRun == nil || (currentRun?.botID == id && currentRun?.strategy == strategy) else { throw DomainError.identityMismatch }
        self.id = id; self.name = name; self.strategy = strategy; self.currentRun = currentRun
    }
}
public enum DomainError: Error { case identityMismatch }

/// Attribution is supplied by authoritative ledger evidence, not by allocating account totals locally.
public enum Attribution: Equatable, Sendable {
    case verified(run: BotRun, evidence: String)
    case accountOnly(accountID: String)
    case uncertain(reason: String)
}
public struct AttributedView<Value: Equatable & Sendable>: Equatable, Sendable {
    public let value: Value?
    public let label: String
    public init(value: Value?, label: String) { self.value = value; self.label = label }
}
public struct Attributed<Value: Equatable & Sendable>: Equatable, Sendable {
    private let value: Value
    public let attribution: Attribution
    public init(value: Value, attribution: Attribution) { self.value = value; self.attribution = attribution }
    public func forBot(_ run: BotRun) -> AttributedView<Value> {
        switch attribution {
        case let .verified(owner, evidence):
            guard !evidence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return AttributedView(value: nil, label: "归属不可靠：缺少归因证据")
            }
            guard owner == run else { return AttributedView(value: nil, label: "不属于此运行实例") }
            return AttributedView(value: value, label: "已按运行实例归因")
        case .accountOnly:
            return AttributedView(value: nil, label: "账户级数据，不能归为机器人收益或持仓")
        case let .uncertain(reason):
            return AttributedView(value: nil, label: "归属不可靠：" + reason)
        }
    }
}
public struct Money: Equatable, Codable, Sendable {
    public let amount: Decimal
    public let currency: String
    public init(amount: Decimal, currency: String) { self.amount = amount; self.currency = currency }
}
public enum PositionSide: String, Codable, Sendable { case long, short }
public struct Position: Equatable, Sendable {
    public let id: String
    public let accountID: String
    public let symbol: String
    public let side: PositionSide
    public let quantity: Decimal
    public let averageEntry: Money
    public let unrealizedPnL: Money?
    public init(id: String, accountID: String, symbol: String, side: PositionSide, quantity: Decimal, averageEntry: Money, unrealizedPnL: Money?) {
        self.id = id; self.accountID = accountID; self.symbol = symbol; self.side = side
        self.quantity = quantity; self.averageEntry = averageEntry; self.unrealizedPnL = unrealizedPnL
    }
}
public enum OrderState: String, Codable, Sendable, CaseIterable {
    case intentRecorded = "intent-recorded"
    case submitting
    case submittedUnknown = "submitted-unknown"
    case accepted
    case partiallyFilled = "partially-filled"
    case cancelPending = "cancel-pending"
    case cancelled, filled, rejected
    case neverArrived = "never-arrived"
    public var isTerminal: Bool {
        switch self {
        case .cancelled, .filled, .rejected, .neverArrived: true
        case .intentRecorded, .submitting, .submittedUnknown, .accepted, .partiallyFilled, .cancelPending: false
        }
    }
    public var requiresReconciliation: Bool {
        switch self {
        case .submittedUnknown, .cancelPending: true
        case .intentRecorded, .submitting, .accepted, .partiallyFilled, .cancelled, .filled, .rejected, .neverArrived: false
        }
    }
}
public enum OrderSide: String, Codable, Sendable { case buy, sell }
/// Public orderId is opaque. No clientOrderId or client-side submission/retry path exists here.
public struct Order: Equatable, Sendable {
    public let orderID: String
    public let accountID: String
    public let symbol: String
    public let side: OrderSide
    public let quantity: Decimal
    public let filledQuantity: Decimal
    public let state: OrderState
    public init(orderID: String, accountID: String, symbol: String, side: OrderSide, quantity: Decimal, filledQuantity: Decimal, state: OrderState) {
        self.orderID = orderID; self.accountID = accountID; self.symbol = symbol; self.side = side
        self.quantity = quantity; self.filledQuantity = filledQuantity; self.state = state
    }
}
public struct Fill: Equatable, Sendable {
    public let id: String
    public let orderID: String
    public let quantity: Decimal
    public let venuePrice: Money
    public let fee: Money
    public let executedAt: Date
    public init(id: String, orderID: String, quantity: Decimal, venuePrice: Money, fee: Money, executedAt: Date) {
        self.id = id; self.orderID = orderID; self.quantity = quantity; self.venuePrice = venuePrice; self.fee = fee; self.executedAt = executedAt
    }
}
public struct AccountAsset: Equatable, Sendable {
    public let accountID: String
    public let total: Money
    public let available: Money
    public let locked: Money
    public init(accountID: String, total: Money, available: Money, locked: Money) {
        self.accountID = accountID; self.total = total; self.available = available; self.locked = locked
    }
}
public enum FundsChangeKind: String, Codable, Sendable { case deposit, withdrawal, realizedPnL, fee, funding, transfer, adjustment }
public struct FundsChange: Equatable, Sendable {
    public let id: String
    public let accountID: String
    public let kind: FundsChangeKind
    public let delta: Money
    public let occurredAt: Date
    public let orderID: String?
    public init(id: String, accountID: String, kind: FundsChangeKind, delta: Money, occurredAt: Date, orderID: String?) {
        self.id = id; self.accountID = accountID; self.kind = kind; self.delta = delta; self.occurredAt = occurredAt; self.orderID = orderID
    }
}
/// Optional values mean unavailable, not zero; period and attribution remain explicit.
public struct PerformanceMetrics: Equatable, Sendable {
    public let periodStart: Date
    public let periodEnd: Date
    public let realizedPnL: Money?
    public let returnFraction: Decimal?
    public let maxDrawdownFraction: Decimal?
    public let winRateFraction: Decimal?
    public init(periodStart: Date, periodEnd: Date, realizedPnL: Money?, returnFraction: Decimal?, maxDrawdownFraction: Decimal?, winRateFraction: Decimal?) {
        self.periodStart = periodStart; self.periodEnd = periodEnd; self.realizedPnL = realizedPnL
        self.returnFraction = returnFraction; self.maxDrawdownFraction = maxDrawdownFraction; self.winRateFraction = winRateFraction
    }
}
/// Robot-facing financial payloads cannot omit provenance. Freshness is checked at the outer render boundary.
public struct BotFinancials: Equatable, Sendable {
    public let positions: [Attributed<Position>]
    public let orders: [Attributed<Order>]
    public let fills: [Attributed<Fill>]
    public let assets: [AccountAsset]
    public let fundsChanges: [Attributed<FundsChange>]
    public let performance: Attributed<PerformanceMetrics>
    public init(positions: [Attributed<Position>], orders: [Attributed<Order>], fills: [Attributed<Fill>], assets: [AccountAsset], fundsChanges: [Attributed<FundsChange>], performance: Attributed<PerformanceMetrics>) {
        self.positions = positions; self.orders = orders; self.fills = fills; self.assets = assets; self.fundsChanges = fundsChanges; self.performance = performance
    }
}
