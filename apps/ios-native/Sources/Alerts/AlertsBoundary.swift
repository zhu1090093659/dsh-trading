import Foundation
import DshTradingContract

/// Alerts/ —— 推送与告警（后续子卡认领）。
///
/// **写作用域：apps/ios-native/Sources/Alerts/**
///
/// 边界：推送载荷校验与深链开放集**已在 Sources/Contract/ContractPush.swift 与
/// ContractOffline.swift 冻结**；非法载荷与外部深链一律 drop，本目录不得自行放宽。
public protocol AlertSink: Sendable {
    func deliver(_ payload: PushPayload) -> Bool
}

