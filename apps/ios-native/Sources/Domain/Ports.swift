//
//  Ports.swift
//  Domain
//
//  跨层端口（冻结件 §6.3）：IOS-4（Features）/ IOS-5（Alerts）/ IOS-6（Offline）都实现或消费
//  这些类型，所以名字与形状不得改（只许只增不改地扩展）。
//
//  分层：Domain -> Contract + Foundation。**本文件不得 import SwiftUI / UIKit**。
//

import Foundation
import DshTradingContract

// MARK: - A0 状态（/a0/status）

/// /a0/status 的 state 字段。**这是"机器人是否已停止"的唯一权威信号**（带外）。
///
/// 归属说明（已报 Lead）：冻结件 §5 把 A0Status 声明在 Transport，§6.3 又要求 Domain 的
/// ObservationSnapshot 携带它；而 §3 的分层不允许 Domain -> Transport。
/// 当前按 §6.3 在 Domain 侧声明，Transport 侧发布时由 Offline/App 适配。
public struct KillState: Hashable, Sendable {
    public let killed: Bool
    public let paused: Bool
    public let reason: String
    public let atMs: Int

    public init(killed: Bool, paused: Bool, reason: String, atMs: Int) {
        self.killed = killed
        self.paused = paused
        self.reason = reason
        self.atMs = atMs
    }

    /// 由权威信号导出执行状态。**没有 A0Status 时不要调它**，那是 .indeterminate。
    public var executionState: ExecutionState {
        ExecutionState.fromA0(killed: killed, paused: paused)
    }
}

/// /a0/status 的响应。拿不到就是 nil，**不许编**。
public struct A0Status: Hashable, Sendable {
    public let ok: Bool
    public let state: KillState
    public let device: String
    public let scopes: [ScopePlane]

    public init(ok: Bool, state: KillState, device: String, scopes: [ScopePlane]) {
        self.ok = ok
        self.state = state
        self.device = device
        self.scopes = scopes
    }

    public var execution: ExecutionState { state.executionState }
}

// MARK: - 观测快照

/// 一次观测抓到的全部事实。**卡片是快照（契约），不依赖 tick 流。**
///
/// reachability 与 execution 都必须是**传输事实**：前者来自有没有拿到 A0/卡片响应，
/// 后者来自 A0 的 killed/paused；拿不到前者就是 .unreachable，拿不到后者就是 .indeterminate。
public struct ObservationSnapshot: Sendable {
    public let atMs: Int
    public let sourceId: String
    public let cards: [Card]
    public let reachability: BotReachability
    public let execution: ExecutionState
    public let a0: A0Status?
    /// 只增：心跳证据。**缺失就是 nil**，不代表健康（心跳正常 != 业务正常）。
    public let heartbeat: HeartbeatStatus?

    public init(
        atMs: Int,
        sourceId: String,
        cards: [Card],
        reachability: BotReachability,
        execution: ExecutionState,
        a0: A0Status?,
        heartbeat: HeartbeatStatus? = nil
    ) {
        self.atMs = atMs
        self.sourceId = sourceId
        self.cards = cards
        self.reachability = reachability
        self.execution = execution
        self.a0 = a0
        self.heartbeat = heartbeat
    }
}

// MARK: - 三个端口

/// 观测数据来源（由 Offline 层把 Transport 适配成它）。
public protocol ObservationSource: Sendable {
    func fetchSnapshot() async throws -> ObservationSnapshot
}

/// 命令回执。
public struct CommandOutcome: Sendable, Hashable {
    public let accepted: Bool
    public let message: String

    public init(accepted: Bool, message: String) {
        self.accepted = accepted
        self.message = message
    }
}

/// 命令下发（由 Transport 适配）。
public protocol CommandSink: Sendable {
    func send(action: ActionKind, params: [String: String]) async throws -> CommandOutcome
}

/// 确认闸门的结论。**unavailable 是 fail-closed 的一种，不是"通过"**。
public enum ConfirmDecision: Equatable, Sendable {
    case approved
    case denied
    case unavailable(reason: String)
}

/// 确认闸门（由 IOS-5 用 LocalAuthentication 实现）。
/// 它只决定"要不要把动作发出去"；发出去之后服务端仍按 scope 与 mandate 判。
public protocol ConfirmationGate: Sendable {
    func confirm(level: ConfirmLevel, reason: String) async -> ConfirmDecision
}
