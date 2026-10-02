import Foundation

/// 设备令牌的组装与切分。
///
/// 服务端（packages/tradectl/src/edge.ts 的 authenticate）按**第一个点号**切分
/// Authorization 头：点号前是 deviceId、点号后是 secret，两段缺一不可 —— 只发 secret 会被判
/// invalid（401）。所以"两段式令牌"由客户端在这里组装，调用方不必各自记得这件事。
/// 同构先例：packages/tradectl/src/pairing-client.ts 的 authorizationFor。
public enum DeviceToken {
    /// 组装 <deviceId>.<secret>。
    ///
    /// 任一段为空、或任一段**自身含点号**时返回 nil：含点号会把令牌的段数改写成三段以上，
    /// 服务端就会把 secret 的一部分当成后半段（静默地拿另一台设备的凭据去比对）。
    /// fail-closed：这种令牌根本不该被造出来。
    public static func token(deviceId: String, secret: String) -> String? {
        guard !deviceId.isEmpty, !secret.isEmpty,
              !deviceId.contains("."), !secret.contains(".")
        else { return nil }
        return deviceId + "." + secret
    }

    /// Authorization 头的完整值：Bearer <deviceId>.<secret>。
    public static func authorization(deviceId: String, secret: String) -> String? {
        token(deviceId: deviceId, secret: secret).map { "Bearer " + $0 }
    }

    /// 与服务端同构的切分（只切第一个点号）；段为空时返回 nil。用于诊断与测试。
    public static func components(_ token: String) -> (deviceId: String, secret: String)? {
        guard let dot = token.firstIndex(of: ".") else { return nil }
        let deviceId = String(token[token.startIndex..<dot])
        let secret = String(token[token.index(after: dot)...])
        guard !deviceId.isEmpty, !secret.isEmpty else { return nil }
        return (deviceId, secret)
    }
}
