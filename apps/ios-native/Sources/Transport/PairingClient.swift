import Foundation

/// 配对结果。secret 只交给 CredentialSink（安全存储），本类型不返回明文给日志。
public struct PairingOutcome: Equatable, Sendable {
    public let credential: StoredCredential
    /// 服务端在配对响应里附带的作用域（edge 会带，见 edge.ts 的 /pair/redeem 分支）。
    /// **仅作诊断/审计**：客户端的授权作用域只来自 /a0/status 或 403 的 required；
    /// 配对响应不做授权（硬规则：配对永不签发 control）。
    public let reportedScopes: [String]
    /// 服务端如实回报的"请求了却没签发"的平面（edge 的 deniedScopes）。
    public let deniedScopes: [String]
}

/// 设备配对：用 edge 的一次性配对码换取设备令牌（POST /pair/redeem）。
///
/// 纪律（对齐 packages/tradectl/src/pairing-client.ts 与 apps/mobile/src/pairing.ts）：
///   - 配对码**一次性**：兑换失败不重试同一个码，也不"猜一个成功"；
///   - 服务端 200 也要**校验响应体**：缺 deviceId/secret 按协议错误处理；
///   - **成功才落库**：失败路径不写安全存储（保留可改 —— 用户可改地址/码重试）；
///   - 请求体**不带 scopes**：配对永不索取（也永不签发）control。
public final class PairingClient: @unchecked Sendable {
    private let http: any HttpClient
    private let sink: any CredentialSink

    public init(http: any HttpClient = URLSessionHttpClient(), sink: any CredentialSink) {
        self.http = http
        self.sink = sink
    }

    public func pair(baseURL: String, code: String, name: String) async throws -> PairingOutcome {
        // 请求与落库用**同一个**规范化地址（否则绑定地址和实际请求地址会差一个斜杠）。
        guard let origin = DshtOrigin.parse(baseURL) else {
            throw TransportError.badResponse("PAIR_ORIGIN_INVALID: 配对地址不是合法的 http(s) URL")
        }
        guard let url = origin.url("/pair/redeem") else {
            throw TransportError.badResponse("PAIR_ORIGIN_INVALID: 无法构造配对请求 URL")
        }

        let requestBody: [String: Any] = ["code": code, "name": name]
        let body = try JSONSerialization.data(withJSONObject: requestBody, options: [.sortedKeys])
        let response = try await http.send(
            DshtRequest(
                method: "POST",
                url: url,
                headers: ["content-type": "application/json"],
                body: body
            )
        )

        guard response.status == 200 else {
            throw ServerFailure.map(status: response.status, body: ServerFailure.parse(response.body))
        }

        guard let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              let deviceId = object["deviceId"] as? String, !deviceId.isEmpty,
              let secret = object["secret"] as? String, !secret.isEmpty
        else {
            throw TransportError.badResponse("PAIR_RESPONSE_INVALID: 响应体缺少 deviceId/secret")
        }
        let credential = StoredCredential(origin: origin, deviceId: deviceId, secret: secret)
        guard credential.isWellFormed else {
            throw TransportError.badResponse("PAIR_RESPONSE_INVALID: 凭据两段不完整（含点号或空段）")
        }

        // 成功才落库。
        try sink.save(credential)
        return PairingOutcome(
            credential: credential,
            reportedScopes: PairingClient.stringArray(object["scopes"]),
            deniedScopes: PairingClient.stringArray(object["deniedScopes"])
        )
    }

    static func stringArray(_ value: Any?) -> [String] {
        guard let array = value as? [Any] else { return [] }
        return array.compactMap { $0 as? String }
    }
}
