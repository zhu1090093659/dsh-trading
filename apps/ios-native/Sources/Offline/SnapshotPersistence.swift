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
