import Foundation

/// 设备令牌的提供者（签名见 Sources/Transport/：代码即判据）。
///
/// authorization() 返回**完整的 Authorization 头值**（Bearer <deviceId>.<secret>）；
/// 未配对返回 nil。forget() 是 401 / 用户解绑的唯一入口 —— 解绑一处生效。
public protocol TokenProvider: Sendable {
    func authorization() -> String?
    func forget()
}

/// 配对成功后落库的目标（只增协议：让 PairingClient 与具体存储解耦，且可被测试注入）。
public protocol CredentialSink: Sendable {
    func save(_ credential: StoredCredential) throws
}

/// Keychain 支撑的令牌提供者：**令牌与绑定 origin 一起存**。
///
/// 为什么 authorization() 是同步的：传输面签名就是这么定的，所以凭据在 init 时读一次并缓存在
/// 内存里（敏感值只在本进程内，且不会出现在 description 里）。写/清都经 CredentialVault，
/// 落点只有一个。
public final class KeychainTokenProvider: TokenProvider, CredentialSink, @unchecked Sendable {
    private let vault: CredentialVault
    private let lock = NSLock()
    private var credential: StoredCredential?

    public init(store: SecureStore, key: String = CredentialVault.defaultKey) throws {
        self.vault = CredentialVault(store: store, key: key)
        self.credential = try self.vault.load()
    }

    public init(vault: CredentialVault) throws {
        self.vault = vault
        self.credential = try vault.load()
    }

    /// 配对绑定的 origin（未配对为 nil）。跨源守卫的"绑定"一侧就是它。
    public var boundOrigin: DshtOrigin? {
        lock.lock(); defer { lock.unlock() }
        return credential?.origin
    }

    public var current: StoredCredential? {
        lock.lock(); defer { lock.unlock() }
        return credential
    }

    public func authorization() -> String? {
        lock.lock(); defer { lock.unlock() }
        return credential?.authorization
    }

    /// 只有目标 origin 与绑定 origin **相等**时才给令牌。
    /// 与桌面壳 device-credential.authorization(baseUrl) 同一立场：换了地址（哪怕只是端口不同）
    /// 一律不外发 —— 否则一次配置改错就把设备密钥交给了另一个 host。
    public func authorization(ifBoundTo origin: DshtOrigin) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let credential, credential.origin == origin else { return nil }
        return credential.authorization
    }

    public func save(_ credential: StoredCredential) throws {
        try vault.save(credential)
        lock.lock(); defer { lock.unlock() }
        self.credential = credential
    }

    public func forget() {
        lock.lock()
        credential = nil
        lock.unlock()
        try? vault.clear()
    }
}
