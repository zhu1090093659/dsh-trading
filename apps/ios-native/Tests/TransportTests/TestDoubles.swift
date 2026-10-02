import Foundation
@testable import DshTradingTransport

/// 记录调用的 HTTP **契约假件（spy）**：实现同一个 HttpClient 接口，把每次调用原样记下来。
///
/// 它的核心用途只有一个：断言"HTTP 层零调用"。真服务器只能证明"没收到"，
/// 这个缝能证明"没有发出"—— 跨源拒绝的判据正是后者（apps/ios-native/README.md §6 不变量 #4；
/// 用例：DshtApiClientTests.testCrossOriginRequestThrowsOriginNotBoundAndNeverTouchesHttpLayer）。
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

/// 记录 forget() 的令牌提供者（契约假件）：401 的语义是"清掉本地令牌"，
/// 这条断言必须在提供者上看到，而不是靠"应该会清"。
final class SpyTokenProvider: TokenProvider, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    private var forgetCount = 0

    init(_ value: String?) {
        self.value = value
    }

    func authorization() -> String? {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    func forget() {
        lock.lock()
        value = nil
        forgetCount += 1
        lock.unlock()
    }

    var forgets: Int {
        lock.lock(); defer { lock.unlock() }
        return forgetCount
    }

    var current: String? {
        lock.lock(); defer { lock.unlock() }
        return value
    }
}

extension DshtOrigin {
    /// 测试里最常用的绑定 origin。
    static var loopback: DshtOrigin {
        DshtOrigin(scheme: "http", host: "127.0.0.1", port: 3081)
    }
}
