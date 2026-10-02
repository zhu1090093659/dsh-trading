import Foundation

/// 配对成功后落库的设备凭据。
///
/// 三条纪律：
///   1. **令牌与绑定 origin 一起存**：落库的不只是密钥，还有"它属于哪台 bot" —— 重启后才知道
///      该把令牌发给谁，也才挡得住"换个地址还用旧令牌"（桌面壳 device-credential 同立场）。
///   2. **这里没有 scopes**：作用域的唯一来源是 /a0/status（或 403 的 required）。
///      配对响应不做授权（apps/ios-native/README.md §6 不变量 #5：配对永不签发 control）——
///      把 scopes 存进凭据就等于让"配对时服务端写了什么"变成客户端的授权事实。
///   3. **secret 不进日志**：description/debugDescription/反射视图一律脱敏。
public struct StoredCredential: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let origin: DshtOrigin
    public let deviceId: String
    public let secret: String

    public init(origin: DshtOrigin, deviceId: String, secret: String) {
        self.origin = origin
        self.deviceId = deviceId
        self.secret = secret
    }

    /// 完整 Authorization 头值；凭据不自洽（含点号/空段）时为 nil。
    public var authorization: String? {
        DeviceToken.authorization(deviceId: deviceId, secret: secret)
    }

    /// 一份自洽的凭据：两段令牌可组装、origin 是 http(s) 且有主机与端口。
    public var isWellFormed: Bool {
        guard !origin.host.isEmpty, origin.port > 0 else { return false }
        guard origin.scheme == "http" || origin.scheme == "https" else { return false }
        return DeviceToken.token(deviceId: deviceId, secret: secret) != nil
    }

    // MARK: - 脱敏

    public var description: String {
        "StoredCredential(origin: " + origin.value + ", deviceId: " + deviceId + ", secret: <redacted>)"
    }

    public var debugDescription: String { description }

    /// 连反射视图也不放 secret：dump()/Mirror 走的是这里。
    public var customMirror: Mirror {
        Mirror(self, children: [
            "origin": origin.value,
            "deviceId": deviceId,
            "secret": "<redacted>",
        ])
    }
}

/// 凭据的序列化：**读坏数据一律 nil**（fail closed）。
///
/// 宁可让用户重新配对，也不要把半截凭据当成可用凭据 —— 与本仓桌面壳
/// "凭据文件坏了 ⇒ 当作未配对"同一读法。
public enum CredentialCodec {
    public static func encode(_ credential: StoredCredential) throws -> String {
        guard credential.isWellFormed else {
            throw TransportError.badResponse("凭据不完整，拒绝写入安全存储（fail-closed）")
        }
        let object: [String: Any] = [
            "scheme": credential.origin.scheme,
            "host": credential.origin.host,
            "port": credential.origin.port,
            "deviceId": credential.deviceId,
            "secret": credential.secret,
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    /// 解析落库的凭据；任何字段缺失/类型不对/自洽性不足 ⇒ nil。
    public static func decode(_ raw: String?) -> StoredCredential? {
        guard let raw, !raw.isEmpty, let data = raw.data(using: .utf8) else { return nil }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        guard let scheme = object["scheme"] as? String, !scheme.isEmpty,
              let host = object["host"] as? String, !host.isEmpty,
              let port = object["port"] as? Int,
              let deviceId = object["deviceId"] as? String, !deviceId.isEmpty,
              let secret = object["secret"] as? String, !secret.isEmpty
        else { return nil }
        let credential = StoredCredential(
            origin: DshtOrigin(scheme: scheme, host: host, port: port),
            deviceId: deviceId,
            secret: secret
        )
        return credential.isWellFormed ? credential : nil
    }
}

/// 凭据的存取（凭据只进传入的 SecureStore；本类型自己从不落盘、从不打印）。
///
/// 当前实现是 Keychain 支撑的（见 KeychainSecureStore）；store 以协议注入，
/// 让"用哪套存储"成为显式选择，也让 fail-closed 解析能在不碰真实 Keychain 的情况下被覆盖。
public final class CredentialVault: @unchecked Sendable {
    public static let defaultKey = "dshtrading.device"

    private let store: SecureStore
    public let key: String
    private let lock = NSLock()

    public init(store: SecureStore, key: String = CredentialVault.defaultKey) {
        self.store = store
        self.key = key
    }

    /// 写入前先自洽性检查（fail-closed：不完整就**不写**，而不是写进去再在读时兜底）。
    public func save(_ credential: StoredCredential) throws {
        let encoded = try CredentialCodec.encode(credential)
        lock.lock(); defer { lock.unlock() }
        try store.save(key, encoded)
    }

    /// 读不到或读到坏数据一律 nil（Keychain 自身的失败仍然抛出，因为那是环境问题不是"未配对"）。
    public func load() throws -> StoredCredential? {
        lock.lock()
        let raw: String?
        do {
            raw = try store.load(key)
        } catch {
            lock.unlock()
            throw error
        }
        lock.unlock()
        return CredentialCodec.decode(raw)
    }

    public func clear() throws {
        lock.lock(); defer { lock.unlock() }
        try store.remove(key)
    }
}
