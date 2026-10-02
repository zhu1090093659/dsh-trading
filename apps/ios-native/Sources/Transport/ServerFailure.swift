import Foundation
import DshTradingContract

/// 服务端错误体的解析与映射（配对与 /v1 共用一处，避免两套判据）。
///
/// edge 的错误体形状（packages/tradectl/src/edge.ts）：
///   401 -> { code: 'EDGE_UNAUTHORIZED', message }
///   403 -> { code: 'EDGE_SCOPE_REQUIRED', message, required }
/// /v1 面的 403 用 { code: 'SCOPE_REQUIRED', required, granted }（api-v1.ts），
/// 426 用 { code: 'CLIENT_TOO_OLD', message } —— 这里两种 403 都认，只按 required 归类。
public enum ServerFailure {
    public struct Body: Equatable, Sendable {
        public let code: String?
        public let message: String?
        public let required: String?
        public init(code: String? = nil, message: String? = nil, required: String? = nil) {
            self.code = code
            self.message = message
            self.required = required
        }
    }

    public static func parse(_ data: Data) -> Body {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return Body()
        }
        return Body(
            code: object["code"] as? String,
            message: object["message"] as? String,
            required: object["required"] as? String
        )
    }

    /// 把一次非 200 响应映射成 TransportError。
    ///
    /// badResponse 的负载 = 服务端 code（有就给原样，没有就给 "HTTP <status>"）——
    /// 这样 400 PAIR_CODE_INVALID / 429 PAIR_RATE_LIMITED 这类"业务拒绝"的码不会被吞掉。
    public static func map(status: Int, body: Body) -> TransportError {
        switch status {
        case 401:
            return .unauthorized(code: body.code ?? "EDGE_UNAUTHORIZED", message: body.message ?? "")
        case 403:
            if let required = body.required, let plane = ScopePlane(rawValue: required) {
                return .scopeRequired(required: plane)
            }
            return .badResponse(body.code ?? "HTTP 403")
        case 426:
            return .clientTooOld(status: 426, code: body.code ?? "CLIENT_TOO_OLD")
        default:
            return .badResponse(body.code ?? ("HTTP " + String(status)))
        }
    }
}
