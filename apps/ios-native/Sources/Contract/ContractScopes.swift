import Foundation

/// scope 三平面（P4 步骤 1）：read / command / control。
///
/// **control 永不默认签发**：它是"停掉一切"的开关（kill/pause/flatten），默认给出等于把
/// 紧急刹车交给每个新设备。等价实现自 packages/contract/src/scopes.ts。
///
/// 写作用域：apps/ios-native/Sources/Contract/**
public enum ScopePlane: String, CaseIterable, Sendable, Hashable {
    case read
    case command
    case control
}

/// 三个平面（声明顺序是契约的一部分：客户端可以依赖它做 diff）。
public let scopePlanes: [ScopePlane] = ScopePlane.allCases

/// 默认签发的平面（配对时给的）。
public let defaultScopePlanes: [ScopePlane] = [.read]

/// 需要显式授予的平面。
public let explicitScopePlanes: [ScopePlane] = [.control]

/// 判定一个字符串是不是合法平面。
public func isScopePlane(_ value: String) -> Bool {
    ScopePlane(rawValue: value) != nil
}

/// 过滤出"可以默认签发"的平面：无论请求里怎么写，control 都被剔除。
public func grantableByDefault(_ requested: [String]) -> [ScopePlane] {
    var wanted = Set(requested.compactMap { ScopePlane(rawValue: $0) })
    wanted.formUnion(defaultScopePlanes)
    return scopePlanes.filter { wanted.contains($0) && !explicitScopePlanes.contains($0) }
}
