import Foundation
import DshTradingContract

/// A0 的 wire 类型**只有一个家**：Sources/Contract/ContractA0.swift。
///
/// KillState / A0Status 是 Transport 与 Domain 的共同上游，而接口冻结 §3 不允许两者互相
/// import —— 唯一合法的共同上游就是 Contract。这里给别名：Transport 的公开 API 名保持不变，
/// 两个家合并成一个（此前 Domain 与 Contract 撞名导致 Offline 的 A0Status 歧义）。
///
/// 解码语义也随之上移：Contract 的 A0Status 是 Decodable，killed/paused/ok 缺失即抛错
/// （绝不默认 false），未知 scope 丢弃（不授权）。
public typealias KillState = DshTradingContract.KillState

/// GET /a0/status 的结果（Contract 的 A0Status）。
///
/// `scopes` 是**授权事实的唯一来源**（配对响应不做授权）：客户端拿到的作用域只有两条路——
/// 这里的 /a0/status，或 403 的 required。不得自己假设有 control。
public typealias A0Status = DshTradingContract.A0Status

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
