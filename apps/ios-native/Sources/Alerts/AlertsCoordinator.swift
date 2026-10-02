import Foundation
import DshTradingContract
import DshTradingDomain

/// 一条推送走完整条流水之后的结果。
public enum AlertsReceiveResult: Equatable, Sendable {
    /// 被丢弃（载荷非法 / 深链不可用 / 乱序旧通知）。**丢弃必须带原因**，不静默吞。
    case dropped(reason: String)
    /// 已入闭环并交给系统通知端口。
    case delivered(record: AlertRecord, decision: PushDecision, interrupted: Bool)
}

/// 告警接收的总装：接收 → 校验（Contract）→ 偏好/静默 → revision 守卫 → 闭环 → 通知端口。
///
/// 关于"未注册推送 token 也不得影响观测面"：
///   - 推送注册状态只是本协调器上的一个事实（pushRegistration），**不参与任何观测路径**；
///   - 观测面走 Transport（/v1/cards、/a0），与 APNs 注册无关；
///   - 因此 receive(...) 在 .notRegistered 下照常工作（有用例钉住）。
public final class AlertsCoordinator: @unchecked Sendable {
    private let lifecycle: AlertLifecycle
    private let notifications: any AlertNotificationPort
    private let clock: @Sendable () -> Int
    private let minuteOfDay: @Sendable (Int) -> Int
    private let lock = NSLock()
    private var preferences: AlertPreferences
    private var registration: PushRegistrationState = .notRegistered
    /// 每个 desk 已处理的最大 revision（Double：**不做整数截断**，否则 3.4 会被当成 3 而放行）。
    private var latestRevisionByDesk: [String: Double] = [:]

    /// - Parameters:
    ///   - clock: 毫秒时钟（注入，便于确定性断言；**不用 sleep**）。
    ///   - minuteOfDay: 把毫秒时间折成"本地一天中的第几分钟"（静默时段判据）；默认按 UTC 折算，
    ///     真实 App 应传入按本地时区折算的实现。
    public init(
        lifecycle: AlertLifecycle,
        notifications: any AlertNotificationPort,
        preferences: AlertPreferences = AlertPreferences(),
        clock: @escaping @Sendable () -> Int,
        minuteOfDay: @escaping @Sendable (Int) -> Int = { milliseconds in (milliseconds / 60_000) % 1440 }
    ) {
        self.lifecycle = lifecycle
        self.notifications = notifications
        self.preferences = preferences
        self.clock = clock
        self.minuteOfDay = minuteOfDay
    }

    public var pushRegistration: PushRegistrationState {
        lock.withLock { registration }
    }

    public func updateRegistration(_ state: PushRegistrationState) {
        lock.withLock { registration = state }
    }

    public var currentPreferences: AlertPreferences {
        lock.withLock { preferences }
    }

    public func updatePreferences(_ next: AlertPreferences) {
        lock.withLock { preferences = next }
    }

    /// 从 APNs userInfo 接收（系统回调路径）。
    public func receive(apnsUserInfo userInfo: [AnyHashable: Any]) async -> AlertsReceiveResult {
        guard let payload = PushIntake.accept(apnsUserInfo: userInfo) else {
            return .dropped(reason: "载荷非法或深链不可用（acceptedPush 拒绝）")
        }
        return await receive(payload: payload)
    }

    /// 从 JSON 字节接收（测试与本地回放路径）。
    public func receive(json data: Data) async -> AlertsReceiveResult {
        guard let payload = PushIntake.accept(json: data) else {
            return .dropped(reason: "载荷非法或深链不可用（acceptedPush 拒绝）")
        }
        return await receive(payload: payload)
    }

    public func receive(payload: PushPayload) async -> AlertsReceiveResult {
        let current = currentPreferences
        let now = clock()
        let decision = PushHandler.decide(payload, preferences: current, minuteOfDay: minuteOfDay(now))
        guard case .open(_, let interrupted, _, _) = decision else {
            if case .drop(let reason) = decision { return .dropped(reason: reason) }
            return .dropped(reason: "未打开")
        }
        guard acceptRevision(payload) else {
            return .dropped(reason: "乱序旧通知：revision 落后于已处理的最新值")
        }
        let record = lifecycle.observe(payload, atMs: now)
        let content = AlertContentBuilder.content(for: payload, detail: current.lockScreenDetail)
        await notifications.deliver(content, interrupted: interrupted)
        return .delivered(record: record, decision: decision, interrupted: interrupted)
    }

    /// 点通知本体：走深链开放集（未知 screen 不跳）。
    @discardableResult
    public func route(_ url: String, opener: any DeeplinkOpening) -> DeeplinkResult {
        DeeplinkRouter.route(url, opener: opener)
    }

    /// 通知动作 → 确认闸门。未知动作标识返回 nil（丢弃，不猜）。
    @discardableResult
    public func handleNotificationAction(
        _ identifier: String,
        gate: any ConfirmationGate,
        reason: String
    ) async -> ConfirmDecision? {
        guard let action = AlertsNotificationAction.actionKind(for: identifier) else { return nil }
        return await gate.confirm(level: confirmLevel(for: action), reason: reason)
    }

    /// 通知注册完后把类目装上（动作集合 = PushAction ∩ ActionKind）。
    public func installCategories() async {
        await notifications.setCategories(AlertCategories.all)
    }

    /// revision 守卫：同一 desk 上落后于已处理最新的通知一律丢弃（APNs 不保证顺序）。
    private func acceptRevision(_ payload: PushPayload) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let latest = latestRevisionByDesk[payload.deskId], payload.revision < latest {
            return false
        }
        latestRevisionByDesk[payload.deskId] = payload.revision
        return true
    }
}
