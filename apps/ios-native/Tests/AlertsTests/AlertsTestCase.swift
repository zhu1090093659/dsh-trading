import XCTest
import DshTradingContract
import DshTradingDomain
@testable import DshTradingAlerts

/// Alerts 用例的公共夹具与端口假件。
///
/// **零 mock 内部服务**：这里的假件都是**契约假件**（实现同一个端口协议、记录调用），
/// 用来替代"无法在沙箱/模拟器里真正验证的系统能力"（通知中心、生物识别）；
/// 业务判据（载荷校验、深链开放集、确认档位、闭环状态）全部用真实实现 + 真实 JSON 夹具跑。
/// **零 sleep**：时间由注入的 clock 给，测试里直接推进数字。
class AlertsTestCase: XCTestCase {
    /// 一条合法载荷的 JSON 夹具（字段按契约要求）。
    static func payloadJSON(
        kind: String = "escalation",
        severity: String = "warning",
        deskId: String = "desk-1",
        deeplink: String = "dshtrading://decisions",
        expiresInMs: Double = 60_000,
        actions: [String] = [],
        fallbackText: String = "dsh-trading 有一条通知",
        revision: Double = 7
    ) -> Data {
        let object: [String: Any] = [
            "kind": kind, "severity": severity, "deskId": deskId, "deeplink": deeplink,
            "expiresInMs": expiresInMs, "actions": actions, "fallbackText": fallbackText,
            "revision": revision,
        ]
        return (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }

    /// APNs userInfo 夹具：嵌套 dsht 段。
    static func apnsUserInfo(payload: Data, alert: String = "通知") -> [AnyHashable: Any] {
        let business = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] ?? [:]
        return ["aps": ["alert": alert, "sound": "default"], "dsht": business]
    }

    static func decode(_ data: Data) -> PushPayload {
        let payload = try? JSONDecoder().decode(PushPayload.self, from: data)
        return payload ?? PushPayload(kind: "", severity: "", deskId: "", deeplink: "", expiresInMs: -1, fallbackText: "", revision: -1)
    }
}

/// 通知端口的契约假件：记录类目与送达内容（含是否打断）。
final class RecordingNotificationPort: AlertNotificationPort, @unchecked Sendable {
    private let lock = NSLock()
    private var storedCategories: [NotificationCategory] = []
    private var deliveredContents: [AlertNotificationContent] = []
    private var deliveredInterrupted: [Bool] = []
    private var authorizationGranted = true

    func setCategories(_ categories: [NotificationCategory]) async {
        lock.withLock { storedCategories = categories }
    }

    func requestAuthorization() async -> Bool {
        lock.withLock { authorizationGranted }
    }

    func deliver(_ content: AlertNotificationContent, interrupted: Bool) async {
        lock.withLock {
            deliveredContents.append(content)
            deliveredInterrupted.append(interrupted)
        }
    }

    var categories: [NotificationCategory] { lock.withLock { storedCategories } }
    var delivered: [AlertNotificationContent] { lock.withLock { deliveredContents } }
    var interruptedFlags: [Bool] { lock.withLock { deliveredInterrupted } }
}

/// 生物识别的契约假件：固定结论 + 记录问了几次。
final class RecordingBiometrics: BiometricAuthenticating, @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    private let outcome: BiometricOutcome

    init(_ outcome: BiometricOutcome) {
        self.outcome = outcome
    }

    func authenticate(reason: String) async -> BiometricOutcome {
        lock.withLock { calls += 1 }
        return outcome
    }

    var callCount: Int { lock.withLock { calls } }
}

/// 深链打开的契约假件。
final class RecordingDeeplinkOpener: DeeplinkOpening, @unchecked Sendable {
    private let lock = NSLock()
    private var opened: [DeeplinkScreen] = []

    func open(screen: DeeplinkScreen, id: String?) {
        lock.withLock { opened.append(screen) }
    }

    var screens: [DeeplinkScreen] { lock.withLock { opened } }
    var count: Int { lock.withLock { opened.count } }
}
