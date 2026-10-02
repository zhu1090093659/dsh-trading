import Foundation
import DshTradingContract

#if canImport(UserNotifications)
import UserNotifications

/// AlertNotificationPort 的真实实现：UNUserNotificationCenter。
///
/// center 用闭包注入而不是在 init 里取：UNUserNotificationCenter.current() 要求进程有
/// 合法的应用 bundle，在单元测试/命令行环境里取它没有意义（也没法验）。这里的默认闭包
/// 只在真正调用方法时才求值。
public final class UserNotificationCenterPort: AlertNotificationPort, @unchecked Sendable {
    private let centerProvider: @Sendable () -> UNUserNotificationCenter

    public init(centerProvider: @escaping @Sendable () -> UNUserNotificationCenter = { UNUserNotificationCenter.current() }) {
        self.centerProvider = centerProvider
    }

    public func setCategories(_ categories: [NotificationCategory]) async {
        let set = Set(categories.map { category in
            UNNotificationCategory(
                identifier: category.id,
                actions: category.actions.map { identifier in
                    UNNotificationAction(identifier: identifier, title: identifier, options: [])
                },
                intentIdentifiers: [],
                options: []
            )
        })
        centerProvider().setNotificationCategories(set)
    }

    public func requestAuthorization() async -> Bool {
        (try? await centerProvider().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    public func deliver(_ content: AlertNotificationContent, interrupted: Bool) async {
        let notification = UNMutableNotificationContent()
        notification.title = content.title
        notification.body = content.body
        notification.categoryIdentifier = content.categoryId
        notification.userInfo = content.userInfo
        if interrupted { notification.sound = .default }
        let identifier = content.userInfo["dedupeKey"] ?? UUID().uuidString
        let request = UNNotificationRequest(identifier: identifier, content: notification, trigger: nil)
        try? await centerProvider().add(request)
    }
}

/// UNUserNotificationCenterDelegate 的桥接实现。
///
/// 决定逻辑全是纯函数（AlertPresentation / AlertsNotificationAction），这里只做
/// "系统回调 → 纯函数 → 回调"的搬运，所以判断本身可以在单测里真断言。
///
/// 送达边界如实说明：**APNs 不保证及时送达**，本地通知也可能被系统的专注模式/摘要压制；
/// 因此告警页看到的"最近一次状态"不能假设与推送同步，推送只是提示，权威态仍在 /v1 快照。
public final class AlertNotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    private let onAction: @Sendable (ActionKind, String) -> Void
    private let onDeeplink: @Sendable (String) -> Void

    public init(
        onAction: @escaping @Sendable (ActionKind, String) -> Void,
        onDeeplink: @escaping @Sendable (String) -> Void
    ) {
        self.onAction = onAction
        self.onDeeplink = onDeeplink
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let severity = notification.request.content.userInfo["severity"] as? String ?? ""
        // 前台：critical 一律强提示；其余静默进列表（interrupted 传 false 即"只进列表"）
        switch AlertPresentation.foreground(severity: severity, interrupted: false) {
        case .bannerAndSound: return [.banner, .sound, .list]
        case .silentList: return [.list]
        }
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        if let action = AlertsNotificationAction.actionKind(for: response.actionIdentifier) {
            // 未知动作标识在这里已经是 nil（不猜）；已知动作交给上层过确认闸门
            onAction(action, response.actionIdentifier)
            return
        }
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let deeplink = info["deeplink"] as? String {
            onDeeplink(deeplink)
        }
    }
}
#endif

#if canImport(LocalAuthentication)
import LocalAuthentication

/// BiometricAuthenticating 的真实实现：LAContext。
///
/// **不可用即 fail-closed**：canEvaluatePolicy=false（无硬件/未录入/被 MDM 策略禁用/被系统锁定）
/// 一律返回 .unavailable，由闸门翻成 ConfirmDecision.unavailable —— 绝不降级成"点一下就过"。
public struct LocalAuthenticationBiometrics: BiometricAuthenticating {
    public init() {}

    public func authenticate(reason: String) async -> BiometricOutcome {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return .unavailable(reason: error?.localizedDescription ?? "生物识别不可用")
        }
        do {
            let approved = try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason
            )
            return approved ? .success : .failed
        } catch let laError as LAError {
            switch laError.code {
            case .userCancel, .systemCancel, .appCancel:
                return .canceled
            case .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .passcodeNotSet:
                return .unavailable(reason: "生物识别不可用，code=" + String(laError.code.rawValue))
            default:
                return .failed
            }
        } catch {
            return .failed
        }
    }
}
#endif
