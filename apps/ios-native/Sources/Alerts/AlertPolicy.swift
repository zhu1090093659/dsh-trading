import Foundation
import DshTradingContract

/// 静默时段（本地时间，按"一天中的第几分钟"表达，不扯时区/日历 —— 那是调用方的事）。
public struct QuietHours: Equatable, Sendable {
    public let startMinute: Int
    public let endMinute: Int

    /// 起止都必须在 0..<1440；start == end 视为**空区间**（不是"全天静音"）。
    public init?(startMinute: Int, endMinute: Int) {
        guard (0..<1440).contains(startMinute), (0..<1440).contains(endMinute) else { return nil }
        self.startMinute = startMinute
        self.endMinute = endMinute
    }

    /// 支持跨午夜（如 23:00–07:00）。
    public func contains(minuteOfDay minute: Int) -> Bool {
        guard (0..<1440).contains(minute) else { return false }
        if startMinute == endMinute { return false }
        if startMinute < endMinute { return minute >= startMinute && minute < endMinute }
        return minute >= startMinute || minute < endMinute
    }
}

/// 锁屏是否显示业务细节。**默认 hidden**：锁屏是公共场合，默认不暴露敏感资产信息。
public enum LockScreenDetail: String, Sendable, CaseIterable {
    case hidden
    case full
}

/// 用户的通知偏好（用户可配置）。
public struct AlertPreferences: Equatable, Sendable {
    /// 已静音的 deskId（critical 不受影响）。
    public let mutedDesks: [String]
    /// 静默时段（critical 不受影响）。
    public let quietHours: QuietHours?
    /// 锁屏显示细节还是只给中性提示。
    public let lockScreenDetail: LockScreenDetail
    /// 每笔正常成交是否推送 —— **默认 false**：正常成交会淹没真告警。
    public let pushOnEveryFill: Bool

    public init(
        mutedDesks: [String] = [],
        quietHours: QuietHours? = nil,
        lockScreenDetail: LockScreenDetail = .hidden,
        pushOnEveryFill: Bool = false
    ) {
        self.mutedDesks = mutedDesks
        self.quietHours = quietHours
        self.lockScreenDetail = lockScreenDetail
        self.pushOnEveryFill = pushOnEveryFill
    }
}

/// 一条推送的呈现决定（与 apps/mobile/src/push.ts 的 handlePush 同构）。
public enum PushDecision: Equatable, Sendable {
    case drop(reason: String)
    /// revision 是 **Double**（与 Contract 一致）：服务端可能发 3.5，整数截断会改变语义。
    case open(screen: DeeplinkScreen, interrupt: Bool, critical: Bool, revision: Double)
}

/// 把"契约判据"与"用户偏好"合成一个打开/丢弃的决定。
public enum PushHandler {
    public static func decide(
        _ payload: PushPayload,
        preferences: AlertPreferences,
        minuteOfDay: Int
    ) -> PushDecision {
        let verdict = validatePushPayload(payload)
        guard verdict.valid else {
            // 非法载荷：丢弃并说清原因（不猜、不"尽力而为"地打开）
            return .drop(reason: "载荷非法：" + verdict.problems.joined(separator: "；"))
        }
        switch parseDeeplink(payload.deeplink) {
        case .ok(let screen, _):
            return .open(
                screen: screen,
                interrupt: AlertPolicy.shouldInterrupt(payload, preferences: preferences, minuteOfDay: minuteOfDay),
                critical: payload.severity == PushSeverity.critical.rawValue,
                revision: payload.revision
            )
        case .rejected(let reason):
            // 深链不在本 App 的开放集内（含外部链接）：不打开
            return .drop(reason: "深链不可用：" + reason)
        }
    }
}

/// 用户偏好与打断强度。
public enum AlertPolicy {
    /// 打断 = 契约的 shouldInterrupt（critical 永远打断、其余看 deskId 静音）
    ///      ∧ 不在静默时段内（critical 仍然不受影响）。
    ///
    /// 契约的 shouldInterrupt 是**唯一**的"值不值得叫醒用户"判据，这里只叠加用户自己的静默时段，
    /// 不放宽也不放宽它的 critical 例外。
    public static func shouldInterrupt(_ payload: PushPayload, preferences: AlertPreferences, minuteOfDay: Int) -> Bool {
        // critical 是**所有**静音手段的例外：desk 静音与静默时段都挡不住它。
        // （这条必须在最前面：契约的 shouldInterrupt 对 critical 返回 true，
        //   若之后再用静默时段覆盖，就等于客户端把 critical 例外吃掉了。）
        if payload.severity == PushSeverity.critical.rawValue { return true }
        guard DshTradingContract.shouldInterrupt(payload, muted: preferences.mutedDesks) else { return false }
        if preferences.quietHours?.contains(minuteOfDay: minuteOfDay) == true { return false }
        return true
    }
}
