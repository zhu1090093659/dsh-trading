import Foundation
import DshTradingContract

/// 会话状态。**未配对就是未配对** —— 是一个明确状态，不是空屏，也不是"假设有令牌"。
public enum TransportSessionState: Equatable, Sendable {
    case unpaired
    case paired(StoredCredential)

    public var isPaired: Bool {
        if case .paired = self { return true }
        return false
    }

    /// 已绑定的 bot origin（未配对为 nil）。
    public var origin: DshtOrigin? {
        if case .paired(let credential) = self { return credential.origin }
        return nil
    }

    /// 一行可显示的状态文字（首屏用；未配对必须说清楚，而不是留白）。
    public var text: String {
        switch self {
        case .unpaired:
            return "未配对：请用一次性配对码接入 bot"
        case .paired(let credential):
            return "已配对：" + credential.origin.value
        }
    }
}

/// 客户端版本与能力协商。
///
/// 判据不在客户端：状态码、能力头、降级语义都由 DshTradingContract 定义
/// （TS 契约是唯一权威）。这里只负责"把一次真实响应的能力交给契约"，不重复实现、也不放宽。
public enum TransportHandshake {
    /// 客户端声明的能力（与 apps/mobile/src/session.ts 的 CLIENT_CAPS 同一套命名）。
    public static let clientCaps: [String] = ["cards.v1", "confirm.biometric", "offline.staleness"]

    /// 用服务端声明的能力完成协商。
    public static func verdict(serverCaps: [String], requiredCaps: [String] = []) -> VersionVerdict {
        negotiateVersion(
            clientMajor: ApiContract.major,
            clientCaps: clientCaps,
            requiredCaps: requiredCaps,
            serverCaps: serverCaps
        )
    }

    /// 把协商结果渲染成一行可显示的文字。
    public static func describe(_ verdict: VersionVerdict) -> String {
        switch verdict {
        case .ok(_, let downgraded):
            let downgradeText = downgraded.isEmpty ? "无降级" : "降级：" + formatCaps(downgraded)
            return "契约可用（" + downgradeText + "）"
        case .rejected(let status, let code, _):
            return "客户端与服务器不兼容（HTTP " + String(status) + "：" + code + "）"
        }
    }

    /// 客户端过旧的专用判定（供 UI 决定是否提示升级）。
    public static func isClientTooOld(_ verdict: VersionVerdict) -> Bool {
        if case .rejected(let status, _, _) = verdict {
            return status == ApiContract.clientTooOldStatus
        }
        return false
    }
}

/// 把三块拼成一条流水：配对 → 安全存储 → 带令牌的 API 客户端。
///
/// 价值不在"多写一层"，而在把**顺序与失败处理**固定下来：
///   - 未配对时 apiClient() 返回 nil（不建一个没有令牌的客户端，也不发匿名请求）；
///   - 需要令牌的操作一律从存储读，不把 secret 在调用点之间传来传去；
///   - 客户端只用配对时绑定的那个 origin，调用方给不了别处；
///   - 解绑只需 forget（清存储），不需要逐个调用点改。
public final class TransportSession: Sendable {
    public let tokens: KeychainTokenProvider
    public let http: any HttpClient

    public init(tokens: KeychainTokenProvider, http: any HttpClient = URLSessionHttpClient()) {
        self.tokens = tokens
        self.http = http
    }

    public func state() -> TransportSessionState {
        guard let credential = tokens.current else { return .unpaired }
        return .paired(credential)
    }

    /// 未配对 ⇒ nil（**不是**一个"没有令牌的客户端"）。地址取自配对时绑定的那个。
    public func apiClient() -> DshtApiClient? {
        guard let origin = tokens.boundOrigin else { return nil }
        return DshtApiClient(origin: origin, tokens: tokens, http: http)
    }

    public func pairingClient() -> PairingClient {
        PairingClient(http: http, sink: tokens)
    }

    /// 解绑一处生效（清安全存储 + 清内存令牌）。
    public func forget() {
        tokens.forget()
    }
}
