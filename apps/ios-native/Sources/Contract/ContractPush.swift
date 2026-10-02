import Foundation

/// 推送通知载荷（P4 步骤 4）—— 等价实现自 packages/contract/src/push.ts。
///
/// 倒计时只表达"还剩多久"、不表达"到点自动做什么"；深链只允许应用内路径（`dshtrading://`）。
///
/// 写作用域：apps/ios-native/Sources/Contract/（IOS-1 冻结面）

/// 严重度：封闭三档。
public enum PushSeverity: String, CaseIterable, Sendable, Hashable {
    case info
    case warning
    case critical
}

/// 通知类型：封闭集合。
public enum PushKind: String, CaseIterable, Sendable, Hashable {
    case escalation
    case degradation
    case killConfirmed = "kill-confirmed"
    case mandateExpiring = "mandate-expiring"
    case staleData = "stale-data"
}

/// 通知里可以出现的动作（与卡片的 ActionKind 取交集）。
public enum PushAction: String, CaseIterable, Sendable, Hashable {
    case ack
    case approve
    case reject
    case pause
    case kill
}

/// 允许的应用内深链前缀（只允许应用内，不允许把用户送去任意站点）。
public let deeplinkScheme = "dshtrading://"

/// 通知里的硬上限（与卡片协议同样的棘轮思路）。
public struct PushLimits: Equatable, Sendable, Decodable {
    public let maxActions: Int
    public let maxFallbackChars: Int
    public let maxDeeplinkChars: Int
    public let maxDeskIdChars: Int
    public let maxExpiresInMs: Int

    public init(maxActions: Int, maxFallbackChars: Int, maxDeeplinkChars: Int, maxDeskIdChars: Int, maxExpiresInMs: Int) {
        self.maxActions = maxActions
        self.maxFallbackChars = maxFallbackChars
        self.maxDeeplinkChars = maxDeeplinkChars
        self.maxDeskIdChars = maxDeskIdChars
        self.maxExpiresInMs = maxExpiresInMs
    }
}

/// 生产上限（= TS PUSH_LIMITS）。
public let pushLimits = PushLimits(maxActions: 3, maxFallbackChars: 180, maxDeeplinkChars: 256, maxDeskIdChars: 64, maxExpiresInMs: 24 * 60 * 60 * 1000)

/// 一条推送载荷。kind / severity / actions 是**字符串**（保留未知值，见接口冻结 §4.1）。
public struct PushPayload: Equatable, Sendable, Decodable {
    public let kind: String
    public let severity: String
    public let deskId: String
    public let deeplink: String
    public let expiresInMs: Int
    public let actions: [String]
    public let fallbackText: String
    public let revision: Int

    private enum CodingKeys: String, CodingKey {
        case kind, severity, deskId, deeplink, expiresInMs, actions, fallbackText, revision
    }

    public init(
        kind: String, severity: String, deskId: String, deeplink: String, expiresInMs: Int,
        actions: [String] = [], fallbackText: String, revision: Int
    ) {
        self.kind = kind
        self.severity = severity
        self.deskId = deskId
        self.deeplink = deeplink
        self.expiresInMs = expiresInMs
        self.actions = actions
        self.fallbackText = fallbackText
        self.revision = revision
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? container.decode(String.self, forKey: .kind)) ?? ""
        severity = (try? container.decode(String.self, forKey: .severity)) ?? ""
        deskId = (try? container.decode(String.self, forKey: .deskId)) ?? ""
        deeplink = (try? container.decode(String.self, forKey: .deeplink)) ?? ""
        expiresInMs = (try? container.decode(Int.self, forKey: .expiresInMs)) ?? -1
        actions = try container.decode([String].self, forKey: .actions)
        fallbackText = (try? container.decode(String.self, forKey: .fallbackText)) ?? ""
        revision = (try? container.decode(Int.self, forKey: .revision)) ?? -1
    }
}

/// 校验一条推送载荷。
public func validatePushPayload(_ payload: PushPayload) -> (valid: Bool, problems: [String]) {
    var problems: [String] = []
    if PushKind(rawValue: payload.kind) == nil { problems.append("未知 kind: " + payload.kind) }
    if PushSeverity(rawValue: payload.severity) == nil { problems.append("未知 severity: " + payload.severity) }
    if payload.deskId == "" || payload.deskId.count > pushLimits.maxDeskIdChars {
        problems.append("deskId 必填且不超过 " + String(pushLimits.maxDeskIdChars) + " 字符")
    }
    if !payload.deeplink.hasPrefix(deeplinkScheme) {
        problems.append("deeplink 必须以 " + deeplinkScheme + " 开头（不允许外部链接）")
    } else if payload.deeplink.count > pushLimits.maxDeeplinkChars {
        problems.append("deeplink 超过 " + String(pushLimits.maxDeeplinkChars) + " 字符")
    }
    if payload.expiresInMs <= 0 {
        problems.append("expiresInMs 必须是正的有限数")
    } else if payload.expiresInMs > pushLimits.maxExpiresInMs {
        problems.append("expiresInMs 超过上限 " + String(pushLimits.maxExpiresInMs))
    }
    if payload.actions.count > pushLimits.maxActions {
        problems.append("actions 超过 " + String(pushLimits.maxActions) + " 个")
    } else {
        for action in payload.actions where PushAction(rawValue: action) == nil {
            problems.append("未知 action: " + action)
        }
    }
    // critical 通知必须至少给一个人能按的动作：只喊危险而不给出口，等于把人钉在原地
    if payload.severity == PushSeverity.critical.rawValue && payload.actions.isEmpty {
        problems.append("critical 通知必须至少有一个可用动作")
    }
    if payload.fallbackText.trimmingCharacters(in: .whitespacesAndNewlines) == "" {
        problems.append("fallbackText 必填")
    } else if payload.fallbackText.count > pushLimits.maxFallbackChars {
        problems.append("fallbackText 超过 " + String(pushLimits.maxFallbackChars) + " 字符")
    }
    if payload.revision < 0 {
        problems.append("revision 必须是非负有限数")
    }
    return (problems.isEmpty, problems)
}

/// 唯一接收入口：结构、语义与深链任一非法均 drop。
public func acceptedPush(_ data: Data) -> PushPayload? {
    guard let payload = try? JSONDecoder().decode(PushPayload.self, from: data), validatePushPayload(payload).valid else { return nil }
    guard case .ok = parseDeeplink(payload.deeplink) else { return nil }
    return payload
}

/// 客户端决定"这条通知值不值得叫醒用户"——**只做展示层筛选，不做业务判断**。
public func shouldInterrupt(_ payload: PushPayload, muted: [String]) -> Bool {
    if payload.severity == PushSeverity.critical.rawValue { return true }
    return !muted.contains(payload.deskId)
}
