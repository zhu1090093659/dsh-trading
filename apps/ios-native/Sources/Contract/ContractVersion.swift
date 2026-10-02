import Foundation

/// 版本策略（P4 步骤 1）：URL major + **只增不减** minor + 能力交集 + 426。
///
/// 等价实现自 packages/contract/src/version.ts —— **TS 契约是唯一权威**；一致性由
/// DshTradingContractTests 对 Generated/contract-snapshot.json 的机检断言守住。
///
/// 写作用域：apps/ios-native/Sources/Contract/（IOS-1 冻结面）
public enum ApiContract {
    /// 当前服务端 major（进 URL）。
    public static let major = 1
    /// 当前服务端 minor（只增不减）。
    public static let minor = 0
    /// 服务端兼容的客户端 major 数量：N-2（含当前）。
    public static let compatibleMajorSpan = 3
    /// 能力请求/响应头。
    public static let capsHeader = "x-dsht-caps"
    /// 客户端太旧的状态码（与 HTTP 一致）。
    public static let clientTooOldStatus = 426
}

/// 协商结果。
public enum VersionVerdict: Equatable, Sendable {
    case ok(caps: [String], downgraded: [String])
    case rejected(status: Int, code: String, message: String)
}

/// 解析 `X-Dsht-Caps` 头（逗号分隔，去空、去重、排序）。
public func parseCaps(_ raw: String?) -> [String] {
    guard let raw, raw.trimmingCharacters(in: .whitespacesAndNewlines) != "" else { return [] }
    let parts = raw.split(separator: ",", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { $0 != "" }
    return Array(Set(parts)).sorted()
}

/// 序列化能力集合（稳定顺序，便于比较与日志）。
public func formatCaps(_ caps: [String]) -> String {
    Array(Set(caps)).sorted().joined(separator: ",")
}

/// 版本与能力协商。
public func negotiateVersion(
    clientMajor: Int,
    serverMajor: Int = ApiContract.major,
    clientCaps: [String],
    requiredCaps: [String] = [],
    serverCaps: [String] = []
) -> VersionVerdict {
    if clientMajor > serverMajor {
        return .rejected(
            status: 426,
            code: "CLIENT_TOO_NEW",
            message: "client major " + String(clientMajor) + " is newer than the server major " + String(serverMajor)
        )
    }
    if serverMajor - clientMajor >= ApiContract.compatibleMajorSpan {
        return .rejected(
            status: ApiContract.clientTooOldStatus,
            code: "CLIENT_TOO_OLD",
            message: "client major " + String(clientMajor) + " is beyond the N-2 compatibility window of server major " + String(serverMajor)
        )
    }
    let clientSet = Set(clientCaps)
    let missing = requiredCaps.filter { !clientSet.contains($0) }
    if !missing.isEmpty {
        return .rejected(
            status: ApiContract.clientTooOldStatus,
            code: "CLIENT_TOO_OLD",
            message: "client is missing required capabilities: " + missing.joined(separator: ", ")
        )
    }
    // 保留 serverCaps 的顺序与重复（对齐 JS filter 语义）
    let usable = serverCaps.filter { clientSet.contains($0) }
    let downgraded = serverCaps.filter { !clientSet.contains($0) }
    return .ok(caps: usable, downgraded: downgraded)
}
