import Foundation
import DshTradingContract

/// 通知类目（系统里的 UNNotificationCategory 的纯数据形态）。
public struct NotificationCategory: Equatable, Sendable {
    public let id: String
    public let actions: [String]

    public init(id: String, actions: [String]) {
        self.id = id
        self.actions = actions
    }
}

/// 一条要交给系统的通知内容（不依赖 UserNotifications，便于在测试里真断言）。
public struct AlertNotificationContent: Equatable, Sendable {
    public let title: String
    public let body: String
    public let categoryId: String
    public let userInfo: [String: String]

    public init(title: String, body: String, categoryId: String, userInfo: [String: String]) {
        self.title = title
        self.body = body
        self.categoryId = categoryId
        self.userInfo = userInfo
    }
}

/// 系统通知能力的**可注入端口**。
///
/// 为什么是端口而不是直接调 UNUserNotificationCenter：UserNotifications 在模拟器与沙箱内
/// 无法真正验证（授权弹窗、送达），直接调用既测不了又会让测试依赖系统状态。
/// 真实实现见 SystemAdapters.swift 的 UserNotificationCenterPort。
public protocol AlertNotificationPort: Sendable {
    func setCategories(_ categories: [NotificationCategory]) async
    func requestAuthorization() async -> Bool
    /// interrupted=false 表示静默送达（不进横幅/不响铃），但仍然记录在通知中心。
    func deliver(_ content: AlertNotificationContent, interrupted: Bool) async
}

/// 推送注册状态。**未注册 token 不影响观测面**：它只影响能否收到远端推送，
/// 观测（/v1/cards、/a0）走的是另一条路。
public enum PushRegistrationState: Equatable, Sendable {
    case notRegistered
    case registered
}

/// 通知动作与卡片动作的交集（**动作集合 = PushAction ∩ ActionKind**，按 rawValue 对齐）。
public enum AlertsNotificationAction {
    /// 允许出现在通知里的动作标识。
    public static var identifiers: [String] {
        PushAction.allCases.map(\.rawValue).filter { ActionKind(rawValue: $0) != nil }
    }

    /// 把通知动作标识映射回卡片动作。**未知标识一律 nil**（不猜、不放行）。
    public static func actionKind(for identifier: String) -> ActionKind? {
        guard PushAction(rawValue: identifier) != nil else { return nil }
        return ActionKind(rawValue: identifier)
    }
}

/// 通知类目：一个 PushKind 一个类目，动作取交集。
public enum AlertCategories {
    public static let identifierPrefix = "dsht."
    public static let defaultCategoryId = "dsht.default"

    /// 未知 kind 没有类目（**不猜一个默认类目**，调用方用 defaultCategoryId 明示兜底）。
    public static func categoryId(forKind kind: String) -> String? {
        guard PushKind(rawValue: kind) != nil else { return nil }
        return identifierPrefix + kind
    }

    public static var all: [NotificationCategory] {
        PushKind.allCases.compactMap { kind in
            categoryId(forKind: kind.rawValue).map { NotificationCategory(id: $0, actions: AlertsNotificationAction.identifiers) }
        }
    }

    /// 一条载荷实际可用的动作：载荷声明的 ∩ 已知动作。
    public static func availableActions(for payload: PushPayload) -> [String] {
        payload.actions.filter { AlertsNotificationAction.actionKind(for: $0) != nil }
    }
}

/// 通知内容构造。
///
/// **锁屏默认不暴露业务细节**：hidden 档下正文是一句中性提示，绝不回显 fallbackText
/// （服务端文案里可能带金额/标的，锁屏是公共场合）。
public enum AlertContentBuilder {
    public static func content(for payload: PushPayload, detail: LockScreenDetail) -> AlertNotificationContent {
        AlertNotificationContent(
            title: title(severity: payload.severity, kind: payload.kind),
            body: detail == .full ? payload.fallbackText : neutralBody(severity: payload.severity),
            categoryId: AlertCategories.categoryId(forKind: payload.kind) ?? AlertCategories.defaultCategoryId,
            userInfo: [
                "deeplink": payload.deeplink,
                "deskId": payload.deskId,
                "revision": String(payload.revision),
                "dedupeKey": AlertLifecycle.dedupeKey(for: payload),
                // severity/kind 给前台展示强度用（封闭集合里的词，不是业务数值）
                "severity": payload.severity,
                "kind": payload.kind,
            ]
        )
    }

    /// 标题只说"严重度 + 类型"（都是封闭集合里的词），不回显任何业务数值。
    static func title(severity: String, kind: String) -> String {
        var severityLabel = "通知"
        switch PushSeverity(rawValue: severity) {
        case .critical: severityLabel = "严重告警"
        case .warning: severityLabel = "需要关注"
        case .info: severityLabel = "通知"
        case .none: severityLabel = "通知"
        }
        var kindLabel = "未知类型"
        switch PushKind(rawValue: kind) {
        case .escalation: kindLabel = "升级待处理"
        case .degradation: kindLabel = "降级"
        case .killConfirmed: kindLabel = "刹车已确认"
        case .mandateExpiring: kindLabel = "额度将到期"
        case .staleData: kindLabel = "数据陈旧"
        case .none: kindLabel = "未知类型"
        }
        return severityLabel + "：" + kindLabel
    }

    /// 中性正文：按严重度给固定话术，字段来自封闭枚举，不来自服务端文案。
    static func neutralBody(severity: String) -> String {
        switch PushSeverity(rawValue: severity) {
        case .critical: return "有严重告警，解锁 App 后查看"
        case .warning: return "有需要关注的变化，解锁 App 后查看"
        case .info, .none: return "有新通知，解锁 App 后查看"
        }
    }
}

/// 前台展示强度（对应 UNNotificationPresentationOptions 的纯数据形态）。
public enum ForegroundPresentation: String, Sendable, CaseIterable {
    case bannerAndSound
    case silentList
}

/// 前台呈现决定（纯函数，便于测试；映射到系统枚举在 SystemAdapters.swift）。
public enum AlertPresentation {
    /// critical 一律强提示；其余只在"应当打断"时才出横幅，否则静默进列表（避免告警轰炸）。
    public static func foreground(severity: String, interrupted: Bool) -> ForegroundPresentation {
        if severity == PushSeverity.critical.rawValue { return .bannerAndSound }
        return interrupted ? .bannerAndSound : .silentList
    }
}
