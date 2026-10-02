import Foundation
@testable import DshTradingTransport

/// 记录调用的 HTTP **契约假件（spy）**：实现同一个 HttpClient 接口，把每次调用原样记下来。
///
/// 它的核心用途只有一个：断言"HTTP 层零调用"。真服务器只能证明"没收到"，
/// 这个缝能证明"没有发出"—— 跨源拒绝与代际过期拒绝的判据正是后者
/// （apps/ios-native/README.md §6 不变量 #4；用例：
/// DshtApiClientTests.testCrossOriginRequestThrowsOriginNotBoundAndNeverTouchesHttpLayer、
/// DshtApiClientTests.testRequestFromAClientOfASupersededPairingNeverTouchesHttpLayer）。
final class RecordingHttpClient: HttpClient, @unchecked Sendable {
    typealias Responder = @Sendable (DshtRequest) -> Result<DshtResponse, Error>

    private let lock = NSLock()
    private var recorded: [DshtRequest] = []
    private let responder: Responder

    init(responder: @escaping Responder = { _ in .success(DshtResponse(status: 200)) }) {
        self.responder = responder
    }

    func send(_ request: DshtRequest) async throws -> DshtResponse {
        // withLock 而不是 lock()/unlock()：后者在 Swift 6 里是 noasync（异步上下文禁止裸加锁）。
        lock.withLock { recorded.append(request) }
        return try responder(request).get()
    }

    var requests: [DshtRequest] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    var callCount: Int {
        lock.lock(); defer { lock.unlock() }
        return recorded.count
    }
}

/// 令牌提供者的**契约假件**：实现同一个 TokenProvider + PairingIdentityProviding，
/// 记录 forget() 次数，并像生产实现一样在 save() 时前移配对代际。
///
/// 两种构造方式对应两类断言，别混用：
///   * `init(_:)` 给一个**固定** Authorization 值（不绑定 origin）——只用于断言"发出去的头是什么形状"，
///     以及"没有令牌时一个请求都不发"。origin 绑定这条判据由 `init(credential:)` 与真
///     KeychainTokenProvider 覆盖（CredentialTests）。
///   * `init(credential:)` 给一份带绑定 origin 的凭据——跨源/代际类断言用它。
final class SpyTokenProvider: TokenProvider, PairingIdentityProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var credential: StoredCredential?
    private var fixed: String?
    private var epoch = 0
    private var forgetCount = 0

    /// 固定 Authorization 值（origin 无关，见类型注释）。nil = 未配对（不存令牌）。
    init(_ authorization: String?) {
        self.fixed = authorization
    }

    /// 已配对：一份带绑定 origin 的凭据（代际从 1 起，与"配过一次"一致）。
    init(credential: StoredCredential) {
        self.credential = credential
        self.epoch = 1
    }

    func authorization(ifBoundTo origin: DshtOrigin) -> String? {
        lock.lock(); defer { lock.unlock() }
        if let credential {
            return credential.origin == origin ? credential.authorization : nil
        }
        return fixed
    }

    func forget() {
        lock.lock()
        credential = nil
        fixed = nil
        forgetCount += 1
        lock.unlock()
    }

    /// 记录一次成功配对：凭据换新 + 代际前移（与 KeychainTokenProvider.save 同语义）。
    func save(_ credential: StoredCredential) {
        lock.lock()
        self.credential = credential
        self.epoch += 1
        lock.unlock()
    }

    var pairingIdentity: PairingIdentity? {
        lock.lock(); defer { lock.unlock() }
        if let credential { return PairingIdentity(origin: credential.origin, epoch: epoch) }
        return nil
    }

    var forgets: Int {
        lock.lock(); defer { lock.unlock() }
        return forgetCount
    }

    /// 当前可用的 Authorization 值（解绑后必须为 nil）。
    var current: String? {
        lock.lock(); defer { lock.unlock() }
        return credential?.authorization ?? fixed
    }
}

extension DshtOrigin {
    /// 测试里最常用的绑定 origin。
    static var loopback: DshtOrigin {
        DshtOrigin(scheme: "http", host: "127.0.0.1", port: 3081)
    }
}
