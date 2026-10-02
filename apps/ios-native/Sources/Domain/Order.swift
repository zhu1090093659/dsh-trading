//
//  Order.swift
//  Domain
//
//  订单状态机：**submitted-unknown 是中间态不是终态**，必须收敛，绝不自动重发。
//  三个 id 各司其职（设计文档 §4 / 不变量 9）：
//    clientRequestId 可见可重试（幂等键）；
//    clientOrderId   **永不可见**，本模块连字段都不存在；
//    orderId         观察面上唯一可被客户端引用撤单的句柄（不透明，只比较不解析）。
//

import Foundation

/// 订单方向。
public enum OrderSide: String, ClosedEnumValue, CaseIterable, Sendable {
    case buy
    case sell

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case .buy: return "买入"
        case .sell: return "卖出"
        }
    }
}

/// 订单类型（封闭枚举；未知值由 ClosedEnum 承载）。
public enum OrderType: String, ClosedEnumValue, CaseIterable, Sendable {
    case market
    case limit
    case stopMarket = "stop_market"
    case stopLimit = "stop_limit"
}

/// 订单状态。
///
/// **终态集合完全枚举且必达**：filled / canceled / rejected / expired / neverArrived。
/// submittedUnknown 是唯一"悬着"的状态，它**必须**收敛到终态之一。
public enum OrderState: String, ClosedEnumValue, CaseIterable, Sendable {
    case intentRecorded
    case submitting
    case submitted
    /// 越过网络写边界但没有回报：**中间态，不是终态**。
    case submittedUnknown
    case partiallyFilled
    case filled
    case canceled
    case rejected
    case expired
    /// 终态：查证后确认从未到达 venue。
    case neverArrived

    /// 穷尽 switch（无 default）。
    public var isTerminal: Bool {
        switch self {
        case .filled, .canceled, .rejected, .expired, .neverArrived: return true
        case .intentRecorded, .submitting, .submitted, .submittedUnknown, .partiallyFilled: return false
        }
    }

    /// 是否需要向 venue 查证（**绝不自动重发**）。
    public var requiresVenueQuery: Bool {
        switch self {
        case .submittedUnknown: return true
        case .intentRecorded, .submitting, .submitted, .partiallyFilled, .filled, .canceled, .rejected, .expired, .neverArrived: return false
        }
    }

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case .intentRecorded: return "已记录意图"
        case .submitting: return "提交中"
        case .submitted: return "已报出"
        case .submittedUnknown: return "已报出但结果未知"
        case .partiallyFilled: return "部分成交"
        case .filled: return "已成交"
        case .canceled: return "已撤销"
        case .rejected: return "已拒绝"
        case .expired: return "已过期"
        case .neverArrived: return "从未到达"
        }
    }
}

/// 冷启动/断线后对未完成订单的处置。
///
/// **类型里不存在"重发"这个分支** —— "绝不自动重发"因此是结构保证，不是纪律。
public enum OrderRecovery: Equatable, Sendable {
    /// intent.recorded 有、order.submitted 无 ⇒ 回滚。
    case rollback
    /// 曾越过网络写边界 ⇒ 先按 clientOrderId 向 venue 查，查不到标 submittedUnknown。
    case queryVenue
    /// 已 ack / 部分成交 ⇒ 按 venue 实际重建。
    case rebuildFromVenue
    /// 存活挂单 ⇒ 默认撤销。
    case cancelResting
    /// 终态，无需处置。
    case terminal
}

/// 从订单状态导出处置策略（判据是"是否曾越过网络写边界"）。
public enum OrderRecoveryPolicy {
    public static func recovery(for state: OrderState) -> OrderRecovery {
        switch state {
        case .intentRecorded: return .rollback
        case .submitting, .submitted, .submittedUnknown: return .queryVenue
        case .partiallyFilled: return .rebuildFromVenue
        case .filled, .canceled, .rejected, .expired, .neverArrived: return .terminal
        }
    }
}

/// 客户端可见的订单视图。**没有 clientOrderId**（契约 ids.ts 的唯一下发路径）。
public struct Order: Hashable, Sendable {
    /// 观察面上的订单身份；在 intent.recorded 时、任何网络写之前分配。
    public let orderId: OrderId
    /// 幂等键（可见、可重试）。
    public let clientRequestId: String
    public let botId: BotId
    public let runId: RunInstanceId?
    public let symbol: String
    public let side: OrderSide
    public let type: OrderType
    public let quantity: Decimal
    public let filledQuantity: Decimal
    public let state: OrderState
    /// venue 侧编号：**只是字段、永不作句柄**。
    public let venueOrderId: String?
    public let createdAtMs: EpochMillis
    public let updatedAtMs: EpochMillis

    public init(
        orderId: OrderId,
        clientRequestId: String,
        botId: BotId,
        runId: RunInstanceId?,
        symbol: String,
        side: OrderSide,
        type: OrderType,
        quantity: Decimal,
        filledQuantity: Decimal,
        state: OrderState,
        venueOrderId: String?,
        createdAtMs: EpochMillis,
        updatedAtMs: EpochMillis
    ) {
        self.orderId = orderId
        self.clientRequestId = clientRequestId
        self.botId = botId
        self.runId = runId
        self.symbol = symbol
        self.side = side
        self.type = type
        self.quantity = quantity
        self.filledQuantity = filledQuantity
        self.state = state
        self.venueOrderId = venueOrderId
        self.createdAtMs = createdAtMs
        self.updatedAtMs = updatedAtMs
    }

    /// 悬着的订单（中间态）。终局要求：**不允许存在永远悬着的订单对象**。
    public var isDangling: Bool { !state.isTerminal }

    /// 状态机的收敛路径（供 UI/恢复流程展示，不在这里做网络）。
    public var needsRecovery: Bool { state.requiresVenueQuery }
}
