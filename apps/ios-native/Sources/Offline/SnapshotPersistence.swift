//
//  SnapshotPersistence.swift
//  Offline
//
//  冻结件 §9：**本地持久化只存快照及其 atMs / sourceId**。
//  不存"派生结论"（数据可信度、依赖健康、归因）—— 那些必须每次由当前事实重算，
//  否则一份被持久化的旧结论会在重启后冒充现状。
//

import Foundation
import DshTradingContract

/// 本地快照存储。载荷就是卡片数组，外加被抓到的时刻与来源。
public protocol SnapshotPersistence: Sendable {
    func load() -> OfflineSnapshot<[Card]>?
    func save(_ snapshot: OfflineSnapshot<[Card]>)
    func clear()
}

/// 内存实现。
///
/// @unchecked Sendable 的理由：全部可变状态都在 NSLock 之下，且载荷是值类型；
/// 这是有意的、被文档化的让步（真机上的文件/DB 实现同理，接口不变）。
public final class InMemorySnapshotPersistence: SnapshotPersistence, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: OfflineSnapshot<[Card]>?

    public init() {}

    public func load() -> OfflineSnapshot<[Card]>? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    public func save(_ snapshot: OfflineSnapshot<[Card]>) {
        lock.lock()
        defer { lock.unlock() }
        stored = snapshot
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        stored = nil
    }
}

/// 观测来源身份的**规范化形式**（sourceId 怎么算，只有一个家）。
///
/// 硬要求：**所有配对不得长成同一个字符串**。此前 live 路径把 sourceId 写死成 `"live"`，
/// 于是"这份数据属于哪个配对实例"不可判定，`cached.sourceId == sourceId` 这条校验
/// 在结构上永远为真 —— 一个永不触发的守卫等于没有守卫。
///
/// 代际（epoch）**必须**进来源身份：同一 origin 重新配对（服务端重发凭据 / 换设备）时
/// origin 相同、只有代际变了，而旧缓存必须因此失效（见 PairingIdentity 的同一理由）。
public enum SnapshotSourceId {
    /// fixtures 模式：数据是本机造的，不绑定任何真实配对实例。
    public static let fixtures = "fixtures"
    /// 尚未配对：也是一个明确的身份，不借用任何实例的。
    public static let unpaired = "live:unpaired"

    /// 已配对实例：规范化 origin + 配对代际。
    public static func live(origin: String, epoch: Int) -> String {
        "live:" + origin + "#" + String(epoch)
    }
}

/// 本地快照的**来源身份**归属：一份缓存只有在 sourceId 与当前配对实例一致时才算数。
///
/// 为什么需要这一层：`SnapshotPersistence`（当前的内存实现，以及将来的落盘实现）是
/// **全进程一个槽**，它不区分来源。配对实例 A 的卡片在重新配对到 B 之后仍然躺在槽里；
/// 若没有这层校验，B 的第一次取数失败就会把 A 的数据当成"自己的本地快照"降级渲染出来
/// —— 界面上的持仓/订单于是属于**另一个机器人实例**。
///
/// 两道防线，职责不同、都不许省：
///   1. `load(sourceId:)`：读的时候按来源校验，不认识的一律当作"没有快照"（fail-closed，
///      与"从来没有过本地快照"走**同一条**路径，不另造一种降级显示）；
///   2. `invalidate()`：解绑 / 重新配对时由组合根**主动清空**旧实例的缓存。
///      凭据换了实例时 sourceId 可能不变（同一 origin 重新配对），只靠第 1 道会漏，
///      所以第 2 道是"配对边界"的事实，不是可选优化。
public struct SourceScopedSnapshots: Sendable {
    private let persistence: any SnapshotPersistence

    public init(persistence: any SnapshotPersistence) {
        self.persistence = persistence
    }

    /// 当前来源自己的快照。来源不一致 ⇒ nil（**不是**回退到"用别人的数据凑合显示"）。
    public func load(sourceId: String) -> OfflineSnapshot<[Card]>? {
        guard let cached = persistence.load(), cached.sourceId == sourceId else { return nil }
        return cached
    }

    /// 只落当前来源的快照（调用方保证 sourceId 就是这一份的来源）。
    public func save(_ snapshot: OfflineSnapshot<[Card]>) {
        persistence.save(snapshot)
    }

    /// 解绑 / 重新配对：旧实例的缓存必须失效。
    public func invalidate() {
        persistence.clear()
    }
}

/// 骨架协议 SnapshotStore（IOS-1 的占位）的落地实现：Payload = [Card]。
public struct CardSnapshotStore: SnapshotStore {
    public typealias Payload = [Card]

    private let persistence: any SnapshotPersistence

    public init(persistence: any SnapshotPersistence) {
        self.persistence = persistence
    }

    public func load() -> OfflineSnapshot<[Card]>? {
        persistence.load()
    }

    public func save(_ snapshot: OfflineSnapshot<[Card]>) {
        persistence.save(snapshot)
    }

    public func clear() {
        persistence.clear()
    }
}
