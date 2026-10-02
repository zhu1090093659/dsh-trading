import Foundation

/// 离线快照、陈旧度与深链解析（P4 步骤 4）—— 等价实现自 packages/contract/src/offline.ts。
///
/// **过了 ttl 必须不再显示数据本身**；**深链是封闭集合**，未知目标一律拒绝（不"尽力跳转"）。
///
/// 写作用域：apps/ios-native/Sources/Contract/（IOS-1 冻结面）

/// 陈旧度分档。
public enum Staleness: String, CaseIterable, Sendable, Hashable {
    case fresh
    case aging
    case stale
    case expired
    case unknown
}

/// 一份离线快照。
public struct OfflineSnapshot<T>: Sendable where T: Sendable {
    public let data: T
    public let atMs: Int
    /// 数据来源标识（两种形态不得混显，客户端据此拒绝跨源展示）。
    public let sourceId: String

    public init(data: T, atMs: Int, sourceId: String) {
        self.data = data
        self.atMs = atMs
        self.sourceId = sourceId
    }
}

/// 三档边界（必须 freshMs <= staleMs <= ttlMs）。
public struct StalenessBudget: Equatable, Sendable {
    public let freshMs: Int
    public let staleMs: Int
    public let ttlMs: Int

    public init(freshMs: Int, staleMs: Int, ttlMs: Int) {
        self.freshMs = freshMs
        self.staleMs = staleMs
        self.ttlMs = ttlMs
    }
}

/// 判断陈旧度：age < freshMs ⇒ fresh；< staleMs ⇒ aging；< ttlMs ⇒ stale；>= ttlMs ⇒ expired。
public func stalenessOf<T>(_ snapshot: OfflineSnapshot<T>?, nowMs: Int, budget: StalenessBudget) -> Staleness {
    guard let snapshot else { return .unknown }
    if budget.freshMs > budget.staleMs || budget.staleMs > budget.ttlMs { return .unknown }
    let age = max(0, nowMs - snapshot.atMs)
    if age < budget.freshMs { return .fresh }
    if age < budget.staleMs { return .aging }
    if age < budget.ttlMs { return .stale }
    return .expired
}

/// 一份可以拿去渲染的东西（或明确的"不能渲染"）。
public enum OfflineView<T> {
    case data(T, Staleness, String?)
    case notice(Staleness, String)
}

extension OfflineView: Equatable where T: Equatable {}
extension OfflineView: Sendable where T: Sendable {}

/// 把快照转成可渲染视图。**过期数据不渲染数据本身** —— 这条是本节存在的理由。
public func offlineView<T>(_ snapshot: OfflineSnapshot<T>?, nowMs: Int, budget: StalenessBudget) -> OfflineView<T> {
    let staleness = stalenessOf(snapshot, nowMs: nowMs, budget: budget)
    if staleness == .unknown {
        return .notice(staleness, "还没有本地数据，请联网获取")
    }
    if staleness == .expired {
        let ageSeconds = Int(((Double(nowMs - snapshot!.atMs)) / 1000).rounded())
        return .notice(staleness, "本地数据已过期（" + String(ageSeconds) + " 秒前），请联网获取后再操作")
    }
    let badge = staleness == .fresh ? nil : (staleness == .aging ? "数据可能已变化" : "⚠ 数据陈旧，仅供对照")
    return .data(snapshot!.data, staleness, badge)
}

/// 深链可达的应用内目标（封闭集合）。
public enum DeeplinkScreen: String, CaseIterable, Sendable, Hashable {
    case escalations
    case decisions
    case positions
    case control
}

/// 深链解析结果。
public enum DeeplinkResult: Equatable, Sendable {
    case ok(screen: DeeplinkScreen, id: String?)
    case rejected(reason: String)
}

/// 解析应用内深链。只认封闭集合里的目标，未知目标一律拒绝（**不尽力跳转**）。
public func parseDeeplink(_ url: String) -> DeeplinkResult {
    guard url.hasPrefix(deeplinkScheme) else { return .rejected(reason: "NOT_APP_SCHEME") }
    let rest = String(url.dropFirst(deeplinkScheme.count))
    let segments = rest.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard let screen = segments.first else { return .rejected(reason: "NO_SCREEN") }
    guard let target = DeeplinkScreen(rawValue: screen) else {
        return .rejected(reason: "UNKNOWN_SCREEN: " + screen)
    }
    let id = segments.count > 1 ? (segments[1].removingPercentEncoding ?? segments[1]) : nil
    return .ok(screen: target, id: id)
}
