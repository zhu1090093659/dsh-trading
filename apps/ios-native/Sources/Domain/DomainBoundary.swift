import Foundation

/// Domain/ —— 卡片模型与状态机（后续子卡认领）。
///
/// **写作用域：apps/ios-native/Sources/Domain/**
///
/// 边界：卡片的封闭枚举、校验与可操作性判定**已在 Sources/Contract/ContractCards.swift 冻结**，
/// 本目录只做"把服务端卡片搬进内存状态"，不得再复制一份枚举或另立一套校验。
public protocol CardStore: Sendable {
    var revision: Int { get }
}

