import Foundation

/// A0（机器人执行核）的 wire DTO。
///
/// **为什么放在 Contract**：`KillState` / `A0Status` 是 Transport 与 Domain 的共同上游，
/// 而分层白名单（scripts/ios-native/check-swift-layering.mjs，见 README §1「各层事实之家」）
/// **不允许 Domain 与 Transport 互相 import**；一个事实只能有一个家，
/// 唯一合法的共同上游就是这里。两侧各自 `public typealias` 指过来即可。
///
/// 来源端点（服务端是唯一权威，本文件不新增端点、不改服务端语义）：
///   `GET /a0/status` → `{ ok, state: { killed, paused, reason, atMs }, device, scopes }`
///
/// 写作用域：apps/ios-native/Sources/Contract/（IOS-1 冻结面）

/// 执行核的杀停状态。
public struct KillState: Equatable, Hashable, Sendable, Decodable {
    public let killed: Bool
    public let paused: Bool
    public let reason: String
    /// 该状态的时间戳（服务端时钟，毫秒）。读不到记 0 ⇒ 消费方按"极旧"处理（fail-closed）。
    public let atMs: Int

    private enum CodingKeys: String, CodingKey { case killed, paused, reason, atMs }

    public init(killed: Bool, paused: Bool, reason: String = "", atMs: Int = 0) {
        self.killed = killed
        self.paused = paused
        self.reason = reason
        self.atMs = atMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // killed / paused 是**安全字段**：读不到就抛错（调用方按"拿不到 A0 状态"= 不可判定处理），
        // **绝不**默认成 false —— 那会把"不知道"渲染成"没被杀停"，正是最危险的那种显示。
        killed = try container.decode(Bool.self, forKey: .killed)
        paused = try container.decode(Bool.self, forKey: .paused)
        reason = ((try? container.decodeIfPresent(String.self, forKey: .reason)) ?? nil) ?? ""
        atMs = ((try? container.decodeIfPresent(Int.self, forKey: .atMs)) ?? nil) ?? 0
    }
}

/// `GET /a0/status` 的响应体。
public struct A0Status: Equatable, Hashable, Sendable, Decodable {
    public let ok: Bool
    public let state: KillState
    public let device: String
    /// 该设备**实际**持有的平面。配对从不签发 control，所以这里通常是 `[.read]`。
    public let scopes: [ScopePlane]

    private enum CodingKeys: String, CodingKey { case ok, state, device, scopes }

    public init(ok: Bool, state: KillState, device: String = "", scopes: [ScopePlane] = []) {
        self.ok = ok
        self.state = state
        self.device = device
        self.scopes = scopes
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // ok / state 是判据本身：读不到就抛错，调用方按"看不到机器人"处理（不许默认成成功）。
        ok = try container.decode(Bool.self, forKey: .ok)
        state = try container.decode(KillState.self, forKey: .state)
        device = ((try? container.decodeIfPresent(String.self, forKey: .device)) ?? nil) ?? ""
        // 未知平面**丢弃**而不是抛错：不认识的 scope 永远不授权（fail-closed），
        // 也不该因为多了一个新平面名就让整条状态读不出来。
        let rawScopes = ((try? container.decodeIfPresent([String].self, forKey: .scopes)) ?? nil) ?? []
        scopes = rawScopes.compactMap { ScopePlane(rawValue: $0) }
    }

    /// 该设备是否真的持有 control（配对不会给；只有显式出现在 scopes 里才算）。
    public var hasControl: Bool { scopes.contains(.control) }
}
