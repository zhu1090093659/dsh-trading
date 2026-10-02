import Foundation

/// 设备令牌的提供者。
///
/// **只有一个取令牌入口：authorization(ifBoundTo:)** —— 令牌必须与它绑定的 origin 一起被校验，
/// 不存在"无绑定地取一个令牌"这个动作。未配对或 origin 不匹配一律返回 nil，调用方 fail-closed（不发请求）。
///
/// 这条纪律是"IOS-8：令牌跨源外发"的修复面：此前存在一个无绑定的取令牌入口（不带 ifBoundTo 的那个），
/// 生产路径用的正是它（安全版本写好了却只有测试在调）。无绑定入口已从协议里删除，
/// 并由 scripts/ios-native/check-transport-token-binding.mjs 机检禁止它溜回生产代码
/// （仓内先例：接线台账/门禁比注释可靠）。
public protocol TokenProvider: Sendable {
    /// 只有目标 origin 与绑定 origin 相等时才给完整的 Authorization 头值；否则 nil。
    func authorization(ifBoundTo origin: DshtOrigin) -> String?
    func forget()
}

/// 配对成功后落库的目标（只增协议：让 PairingClient 与具体存储解耦，且可被测试注入）。
public protocol CredentialSink: Sendable {
    func save(_ credential: StoredCredential) throws
}

/// 配对身份的来源：当前是哪一代配对、绑定在哪个 origin。
///
/// 客户端只依赖这个协议（不依赖具体存储），于是"配对代际"可以在不碰 Keychain 的前提下被真实调用路径覆盖
/// —— 这就是 IOS-8 那个负例（旧客户端必须发不出新令牌）能被断言的原因。
public protocol PairingIdentityProviding: Sendable {
    /// 当前配对身份；未配对为 nil。
    var pairingIdentity: PairingIdentity? { get }
}

/// Keychain 支撑的令牌提供者：**令牌与绑定 origin 一起存**，配对代际在内存里递增。
///
/// 为什么这里的方法都是同步的：传输面签名就是这么定的，所以凭据在 init 时读一次并缓存在
/// 内存里（敏感值只在本进程内，且不会出现在 description 里）。写/清都经 CredentialVault，
/// 落点只有一个。
public final class KeychainTokenProvider: TokenProvider, CredentialSink, PairingIdentityProviding, @unchecked Sendable {
    private let vault: CredentialVault
    private let lock = NSLock()
    private var credential: StoredCredential?
    /// 进程内配对代际：每次 save（= 一次配对成功）前移一次。
    private var epoch: Int = 0

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

    /// 当前配对身份（绑定 origin + 本进程的配对代际）；未配对为 nil。
    public var pairingIdentity: PairingIdentity? {
        lock.lock(); defer { lock.unlock() }
        guard let credential else { return nil }
        return PairingIdentity(origin: credential.origin, epoch: epoch)
    }

    /// 只有目标 origin 与绑定 origin **相等**时才给令牌。
    /// 与桌面壳 device-credential.authorization(baseUrl) 同一立场：换了地址（哪怕只是端口不同）
    /// 一律不外发 —— 否则一次配置改错就把设备密钥交给了另一个 host。
    public func authorization(ifBoundTo origin: DshtOrigin) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let credential, credential.origin == origin else { return nil }
        return credential.authorization
    }

    /// 落库并把配对代际前移一次：从此之前创建的客户端一律过期（旧客户端不再能发请求）。
    /// 落库失败（fail-closed 拒绝写不完整凭据）时**不**前移代际：这次配对没有成立。
    public func save(_ credential: StoredCredential) throws {
        try vault.save(credential)
        lock.lock(); defer { lock.unlock() }
        self.credential = credential
        epoch += 1
    }

    public func forget() {
        lock.lock()
        credential = nil
        lock.unlock()
        try? vault.clear()
    }
}
