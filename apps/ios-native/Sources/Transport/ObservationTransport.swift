import Foundation
import DshTradingContract

/// 核心侧的 kill 状态（wire 形状见 packages/tradectl/src/edge.ts 的 KillState）。
public struct KillState: Equatable, Sendable {
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
}

/// GET /a0/status 的结果。
///
/// `scopes` 是**授权事实的唯一来源**（配对响应不做授权）：客户端拿到的作用域只有两条路——
/// 这里的 /a0/status，或 403 的 required。不得自己假设有 control。
public struct A0Status: Equatable, Sendable {
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
}

/// GET /v1/cards 的结果。
public struct CardsPage: Sendable {
    public let cards: [Card]
    public let truncated: Bool
    public let caps: [String]
    public let downgraded: [String]

    public init(cards: [Card], truncated: Bool, caps: [String], downgraded: [String]) {
        self.cards = cards
        self.truncated = truncated
        self.caps = caps
        self.downgraded = downgraded
    }
}

/// 观测面唯一的传输端口（冻结签名来自 INTERFACE-FREEZE.md §5）。
///
/// 上层（Offline/Domain）只依赖这个协议，不依赖 URLSession、也不自行拼路径 ——
/// 端点清单是服务端契约，客户端不造第二个家。
public protocol ObservationTransport: Sendable {
    func ping() async throws -> Bool
    func a0Status() async throws -> A0Status
    func cards(clientCaps: [String]) async throws -> CardsPage
    func command(action: ActionKind, params: [String: String], clientRequestId: String) async throws -> Data
}
