import XCTest
import DshTradingContract
@testable import DshTradingTransport

/// 配对请求的发放计数器（真服务器的回调在别的队列上，闭包必须是 Sendable ⇒ 计数器要自己加锁）。
private final class PairingIssueCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        lock.lock(); defer { lock.unlock() }
        value += 1
        return value
    }
}

/// 会话管理：未配对是明确状态、配对→存储→客户端流水、解绑一处生效、版本与能力协商。
final class TransportSessionTests: TransportTestCase {
    func testUnpairedSessionIsAnExplicitStateNotABlankScreen() throws {
        // Given 从未配对的会话
        let tokens = try KeychainTokenProvider(store: InMemorySecureStore())
        let session = TransportSession(tokens: tokens, http: RecordingHttpClient())

        // When / Then 状态是 .unpaired，有可显示文案，且建不出客户端（不发匿名请求）
        XCTAssertEqual(session.state(), .unpaired)
        XCTAssertFalse(session.state().isPaired)
        XCTAssertTrue(session.state().text.contains("未配对"))
        XCTAssertNil(session.state().origin)
        XCTAssertNil(session.apiClient())
    }

    func testPairingThroughSessionYieldsPairedStateAndUsableClient() async throws {
        // Given 一个既会配对也会应答心跳的真 edge
        let (server, baseURL) = try await startServer { request in
            if request.path == "/pair/redeem" {
                return TestHTTPServer.Reply(status: 200, json: ["deviceId": "dev_1", "secret": "s3cr3t", "scopes": ["read"]])
            }
            return TestHTTPServer.Reply(status: 200, json: ["ok": true, "atMs": 1, "device": "dev_1"])
        }
        let tokens = try KeychainTokenProvider(store: InMemorySecureStore())
        let session = TransportSession(tokens: tokens, http: URLSessionHttpClient())

        // When 配对，然后用会话给出的客户端取心跳
        let outcome = try await session.pairingClient().pair(baseURL: baseURL, code: "ABCD", name: "iPhone")
        let client = try XCTUnwrap(session.apiClient())
        let ok = try await client.ping()

        // Then 状态是 .paired、客户端打在绑定地址上、带两段式令牌
        XCTAssertEqual(session.state(), .paired(outcome.credential))
        XCTAssertEqual(session.state().origin, DshtOrigin.parse(baseURL))
        XCTAssertTrue(ok)
        XCTAssertEqual(server.requests.last?.headers["authorization"], "Bearer dev_1.s3cr3t")
    }

    func testRepairingTheSameOriginSupersedesTheClientThatWasHandedOutBefore() async throws {
        // Given 一个机器人（第一次配对发 dev_1，之后重发 dev_2）
        let issued = PairingIssueCounter()
        let (server, baseURL) = try await startServer { request in
            if request.path == "/pair/redeem" {
                return TestHTTPServer.Reply(
                    status: 200,
                    json: ["deviceId": "dev_" + String(issued.next()), "secret": "s3cr3t"]
                )
            }
            return TestHTTPServer.Reply(status: 200, json: ["ok": true, "atMs": 1, "device": "dev"])
        }
        let tokens = try KeychainTokenProvider(store: InMemorySecureStore())
        let session = TransportSession(tokens: tokens, http: URLSessionHttpClient())
        _ = try await session.pairingClient().pair(baseURL: baseURL, code: "AAAA", name: "iPhone")
        let handedOutBefore = try XCTUnwrap(session.apiClient())

        // When 用同一个地址再配对一次（origin 完全没变，只有配对身份换了）
        _ = try await session.pairingClient().pair(baseURL: baseURL, code: "BBBB", name: "iPhone")
        let handedOutAfter = try XCTUnwrap(session.apiClient())

        // Then 新客户端可用；**旧客户端发不出请求**（它连 /a0/ping 都没发出去）
        let alive = try await handedOutAfter.ping()
        XCTAssertTrue(alive)
        let before = server.requestCount
        let error = await captureTransportError { _ = try await handedOutBefore.ping() }
        XCTAssertEqual(error?.kind, .stalePairing)
        XCTAssertEqual(server.requestCount, before)
    }

    func testForgetReturnsSessionToUnpairedAndEmptiesStorage() async throws {
        // Given 已配对的会话
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 200, json: ["deviceId": "dev_1", "secret": "s3cr3t"])
        }
        let store = InMemorySecureStore()
        let tokens = try KeychainTokenProvider(store: store)
        let session = TransportSession(tokens: tokens, http: URLSessionHttpClient())
        _ = try await session.pairingClient().pair(baseURL: baseURL, code: "ABCD", name: "iPhone")
        XCTAssertTrue(session.state().isPaired)

        // When 解绑（一处）
        session.forget()

        // Then 状态回到未配对、存储清空、客户端建不出来
        XCTAssertEqual(session.state(), .unpaired)
        XCTAssertEqual(store.dump, [:])
        XCTAssertNil(session.apiClient())
    }

    func testHandshakeRejectsWhenClientMissesARequiredCapability() {
        // Given 本次响应要求客户端不具备的能力（trade.confirm 不在 CLIENT_CAPS 里）
        let verdict = TransportHandshake.verdict(serverCaps: ["trade.confirm"], requiredCaps: ["trade.confirm"])

        // When / Then 判为过旧（426），文案是"不兼容"
        XCTAssertTrue(TransportHandshake.isClientTooOld(verdict))
        if case .rejected(let status, let code, _) = verdict {
            XCTAssertEqual(status, ApiContract.clientTooOldStatus)
            XCTAssertEqual(code, "CLIENT_TOO_OLD")
        } else {
            XCTFail("期望 rejected，实际 " + String(describing: verdict))
        }
        XCTAssertTrue(TransportHandshake.describe(verdict).contains("不兼容"))
    }

    func testHandshakeListsDowngradesInsteadOfFailing() {
        // Given 服务端多声明了一个客户端没有的能力
        let verdict = TransportHandshake.verdict(serverCaps: ["cards.v1", "server.only.cap"], requiredCaps: ["cards.v1"])

        // When / Then 仍可用，降级项如实列出（不静默丢弃）
        if case .ok(let caps, let downgraded) = verdict {
            XCTAssertEqual(caps, ["cards.v1"])
            XCTAssertEqual(downgraded, ["server.only.cap"])
        } else {
            XCTFail("期望 ok，实际 " + String(describing: verdict))
        }
        XCTAssertFalse(TransportHandshake.isClientTooOld(verdict))
        XCTAssertTrue(TransportHandshake.describe(verdict).contains("降级：server.only.cap"))
    }

    func testHandshakeStillPassesWhenServerDeclaresNoCaps() {
        // Given 服务端没有声明任何能力（与"声明了空集合"同路：都不算降级）
        let verdict = TransportHandshake.verdict(serverCaps: [], requiredCaps: ["cards.v1"])

        // Then 客户端自备的能力仍算通过
        if case .ok(let caps, let downgraded) = verdict {
            XCTAssertEqual(caps, [])
            XCTAssertEqual(downgraded, [])
        } else {
            XCTFail("期望 ok，实际 " + String(describing: verdict))
        }
        XCTAssertTrue(TransportHandshake.describe(verdict).contains("契约可用"))
    }
}
