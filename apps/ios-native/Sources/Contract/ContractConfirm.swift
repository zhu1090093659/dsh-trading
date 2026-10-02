import Foundation

/// 确认策略（P4 步骤 4）—— 等价实现自 packages/contract/src/confirm.ts。
///
/// "哪些动作需要强确认"这条判据**只有一个家**。不变量：**control 平面上的任何动作都不得低于 biometric**。
///
/// 写作用域：apps/ios-native/Sources/Contract/（IOS-1 冻结面）

/// 确认档位。
public enum ConfirmLevel: String, CaseIterable, Sendable, Hashable {
    case none
    case confirm
    case biometric
}

/// 每个动作的确认档位（**判据的唯一之家**）。switch 不用 default。
private func confirmLevelOf(_ action: ActionKind) -> ConfirmLevel {
    switch action {
    case .ack, .dismiss, .openDetail, .retrySync: return .none
    case .approve, .reject: return .biometric
    case .pause, .resume, .kill, .flatten, .grantControl, .revokeDevice: return .biometric
    }
}

public let actionConfirm: [ActionKind: ConfirmLevel] =
    Dictionary(uniqueKeysWithValues: ActionKind.allCases.map { ($0, confirmLevelOf($0)) })

/// 取一个动作要求的确认档位。
public func confirmLevel(for action: ActionKind) -> ConfirmLevel {
    confirmLevelOf(action)
}

/// 校验确认策略表自身的完整性（**CI 可机检**）。
public func auditConfirmPolicy() -> (ok: Bool, problems: [String]) {
    var problems: [String] = []
    for action in ActionKind.allCases {
        guard let level = actionConfirm[action] else {
            problems.append("动作缺少确认档位: " + action.rawValue)
            continue
        }
        if scopeOf(action) == .control && level != .biometric {
            problems.append("control 类动作 " + action.rawValue + " 的确认档位是 " + level.rawValue + "，低于 biometric")
        }
    }
    return (problems.isEmpty, problems)
}

/// 客户端平台。
public enum ClientPlatform: String, Sendable, CaseIterable {
    case web
    case mobile
}

/// 客户端据此决定"这次点击要不要先过强确认"。
public func requiresBiometric(_ action: ActionKind, platform: ClientPlatform) -> Bool {
    let level = confirmLevel(for: action)
    if level != .biometric { return false }
    // 网页端没有生物识别：不假装有，而是退到 confirm（界面需提示"移动端需生物识别"）
    return platform == .mobile
}
