import Foundation
import DshTradingContract

/// Offline/ —— 离线快照与陈旧度（后续子卡认领）。
///
/// **写作用域：apps/ios-native/Sources/Offline/**
///
/// 边界：陈旧度分档与"过期不渲染数据本身"**已在 Sources/Contract/ContractOffline.swift 冻结**；
/// 本目录只负责持久化与时钟注入，不得自行定义档位或放宽过期规则。
public protocol SnapshotStore: Sendable {
    associatedtype Payload: Sendable
    func load() -> OfflineSnapshot<Payload>?
}

