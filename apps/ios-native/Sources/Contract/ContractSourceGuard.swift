import Foundation

/// 数据源守卫（P4 步骤 5）—— 等价实现自 packages/contract/src/source-guard.ts。
///
/// **跨源永不混显**；**切换期 fail-closed**；**对账要显式**（计数不符即视为未完成）。
///
/// 写作用域：apps/ios-native/Sources/Contract/（IOS-1 冻结面）

/// 带来源标记的一条数据（id 是它在**各自源内**的唯一标识）。
public struct SourcedDatum<T>: Sendable where T: Sendable {
    public let id: String
    public let sourceId: String
    public let value: T

    public init(id: String, sourceId: String, value: T) {
        self.id = id
        self.sourceId = sourceId
        self.value = value
    }
}

/// 对账结果：两边条数必须一致才算对上。
public struct ReconcileReport: Equatable, Sendable {
    public let ok: Bool
    public let activeCount: Int
    public let incomingCount: Int
    public let reason: String?

    public init(ok: Bool, activeCount: Int, incomingCount: Int, reason: String? = nil) {
        self.ok = ok
        self.activeCount = activeCount
        self.incomingCount = incomingCount
        self.reason = reason
    }
}

/// 数据源守卫。
///
/// `T: Sendable` 是本仓 Swift 6 严格并发下对冻结签名的**收紧**（冻结件写的是 `SourceGuard<T>`）：
/// Swift 会为"final class + 全 Sendable 存储属性"自动推断 Sendable，于是 T 必须 Sendable 才能
/// 通过编译。语义不变；只是非 Sendable 的载荷类型不能再用这个守卫。
///
/// 它本身仍是**单线程状态机**（渲染层与切换流程同线程使用）；跨线程共享请由调用方做隔离。
public final class SourceGuard<T: Sendable> {
    private var activeSourceId: String
    private var pendingSourceId: String?

    public init(activeSourceId: String) {
        self.activeSourceId = activeSourceId
        self.pendingSourceId = nil
    }

    public func sourceId() -> String { activeSourceId }

    /// 渲染层唯一入口：只给出当前源的数据（跨源永不混显）。
    public func viewOf(_ data: [SourcedDatum<T>]) -> [SourcedDatum<T>] {
        // 手写循环而不是 filter 闭包：闭包在 Swift 6 严格并发下会牵动 T 的 Sendable 约束，
        // 而冻结签名是 `SourceGuard<T>`（无约束）。行为与 TS 的 filter 完全一致。
        var visible: [SourcedDatum<T>] = []
        for datum in data where datum.sourceId == activeSourceId {
            visible.append(datum)
        }
        return visible
    }

    /// 写操作是否允许（切换期只读）。
    public func writable() -> Bool { pendingSourceId == nil }

    /// 开始切到另一个源：立即进入只读，直到 reconcile 通过。
    public func switchTo(_ nextSourceId: String) {
        // 同一个源不算切换（避免把"刷新"误当成切换而进入只读）
        if nextSourceId == activeSourceId { return }
        pendingSourceId = nextSourceId
    }

    /// 切换中？
    public func switching() -> Bool { pendingSourceId != nil }

    /// 对账：两边条数一致才结束只读；不一致保持只读并给出原因。
    public func reconcile(active: [SourcedDatum<T>], incoming: [SourcedDatum<T>]) -> ReconcileReport {
        var activeCount = 0
        for datum in active where datum.sourceId == activeSourceId { activeCount += 1 }
        var incomingCount = 0
        for datum in incoming where datum.sourceId == pendingSourceId { incomingCount += 1 }
        // 计数不符 ⇒ 不切换、保持只读（宁可停在只读，也不要把半个源显示出来）
        if activeCount != incomingCount {
            return ReconcileReport(
                ok: false, activeCount: activeCount, incomingCount: incomingCount,
                reason: "条数不一致（" + String(activeCount) + " vs " + String(incomingCount) + "），保持只读"
            )
        }
        if let pending = pendingSourceId {
            activeSourceId = pending
            pendingSourceId = nil
        }
        return ReconcileReport(ok: true, activeCount: activeCount, incomingCount: incomingCount, reason: nil)
    }
}
