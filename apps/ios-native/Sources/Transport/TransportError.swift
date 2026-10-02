import Foundation
import DshTradingContract

/// 传输层失败的**分类**（封闭枚举，非穷尽友好入口）。
///
/// 为什么要有它：TransportError 里有些 case 带负载（required / status / code），消费方若直接
/// switch 全部 case，就会被"带负载的分支"绑住；更糟的是，本枚举**只增不减**（2026-10-02 增补
/// unauthorized 就是一次"只增"）。因此提供一个不带负载的分类入口 kind，让消费方可以只按类别
/// 分派、并对未知类别 fail-closed，而不必写 default 吞掉一切。
public enum TransportErrorKind: String, CaseIterable, Sendable {
    /// 目标 origin ≠ 配对绑定 origin（请求根本没有发出）。
    case originNotBound
    /// 连不上服务端，或未配对（没有可用令牌）。
    case unreachable
    /// 服务端回了不能按协议解析的内容。
    case badResponse
    /// 401：令牌缺失/无效，应清掉本地令牌回到未配对。
    case unauthorized
    /// 403：设备缺该作用域。
    case scopeRequired
    /// 426：客户端过旧。
    case clientTooOld
}

/// 传输层的失败词汇。
///
/// 设计原则：**可操作的分支不许塌缩成一个笼统的"网络错误"**。UI 要从错误本身就能分辨
/// "要重新配对"（unauthorized）、"缺作用域"（scopeRequired）、"客户端过旧"（clientTooOld）、
/// "根本没发出去"（originNotBound），而不是靠文案猜。
///
/// 词汇的家就是本类型（代码即判据）。原有五个 case 逐字保留；
/// `unauthorized` 是 2026-10-02 经 Lead 批准的**唯一一次只增**（最初的清单漏了 401 分支，
/// 而 IOS-2 卡明确要求处理 401 EDGE_UNAUTHORIZED）。只增不减：消费方请优先用 kind 分类。
public enum TransportError: Error, Equatable, Sendable {
    /// 目标 origin ≠ 配对绑定 origin。**抛到它即意味着 HTTP 层一次都没被调用。**
    case originNotBound(expected: String, actual: String)
    /// 连不上服务端，或还没有可用设备令牌（未配对）。
    case unreachable(String)
    /// 服务端回了不能按协议解析的内容（坏 JSON / 缺字段 / 非 HTTP 响应）。
    case badResponse(String)
    /// 401：设备令牌缺失或无效（服务端码 EDGE_UNAUTHORIZED）。收到即清掉本地令牌回到未配对。
    case unauthorized(code: String, message: String)
    /// 403：设备缺该作用域（EDGE_SCOPE_REQUIRED / SCOPE_REQUIRED，带 required）。
    case scopeRequired(required: ScopePlane)
    /// 426：客户端过旧（CLIENT_TOO_OLD）。客户端不自行判定兼容性，只如实上报契约的裁决。
    case clientTooOld(status: Int, code: String)

    /// 不带负载的分类入口（非穷尽友好）。
    public var kind: TransportErrorKind {
        switch self {
        case .originNotBound: return .originNotBound
        case .unreachable: return .unreachable
        case .badResponse: return .badResponse
        case .unauthorized: return .unauthorized
        case .scopeRequired: return .scopeRequired
        case .clientTooOld: return .clientTooOld
        }
    }
}
