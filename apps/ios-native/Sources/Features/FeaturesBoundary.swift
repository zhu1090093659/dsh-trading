import Foundation

/// Features/ —— 界面与交互（后续子卡认领）。
///
/// **写作用域：apps/ios-native/Sources/Features/**
///
/// 边界：渲染面必须走契约的 `renderableActions`（非法/未知枚举 ⇒ 空动作集），
/// 不得自行放行卡片上的动作。
public protocol FeatureScreen: Sendable {
    var title: String { get }
}

