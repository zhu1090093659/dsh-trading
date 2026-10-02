import XCTest
import DshTradingContract
@testable import DshTradingTransport

/// 设备配对（POST /pair/redeem）：**真 HTTP 服务器**，不是 mock。
///
/// 判据来自服务端契约（packages/tradectl/src/edge.ts 的 /pair/redeem 分支）与
/// apps/mobile/test/pairing.test.ts、session-manager.test.ts 的既有用例。
final class PairingTests: TransportTestCase {
    private func makeProvider(_ store: InMemorySecureStore) throws -> KeychainTokenProvider {
        try KeychainTokenProvider(store: store)
    }

    func testPairingSuccessStoresCredentialBoundToOriginAndTakesNoScopesFromPairing() async throws {
        // Given 一个按契约应答的 edge：响应里连 control 都带上了（服务端如实回报请求过的平面）
        let (server, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(
                status: 200,
                json: [
                    "deviceId": "dev_1",
                    "secret": "s3cr3t",
                    "scopes": ["read", "command", "control"],
                    "deniedScopes": [],
                ]
            )
        }
        let store = InMemorySecureStore()
        let tokens = try makeProvider(store)
        let client = PairingClient(http: URLSessionHttpClient(), sink: tokens)

        // When 用一次性配对码兑换
        let outcome = try await client.pair(baseURL: baseURL, code: "ABCD-1234", name: "iPhone")

        // Then 两段式令牌可组装、绑定地址就是请求地址、且**授权作用域不来自配对响应**
        XCTAssertEqual(outcome.credential.authorization, "Bearer dev_1.s3cr3t")
        XCTAssertEqual(outcome.credential.origin, DshtOrigin.parse(baseURL))
        XCTAssertEqual(tokens.boundOrigin, DshtOrigin.parse(baseURL))
        XCTAssertEqual(outcome.reportedScopes, ["read", "command", "control"])
        let stored = try XCTUnwrap(store.dump[CredentialVault.defaultKey])
        XCTAssertFalse(stored.contains("scopes"), "配对永不签发 control：凭据里不得存作用域")
        XCTAssertFalse(stored.contains("control"))
        // 请求确实是 POST /pair/redeem，且请求体只有 code/name（不索取 scopes）
        XCTAssertEqual(server.requestCount, 1)
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/pair/redeem")
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.body) as? [String: String]
        )
        XCTAssertEqual(Set(body.keys), ["code", "name"])
        XCTAssertEqual(body["code"], "ABCD-1234")
    }

    func testPairingServerRejectionKeepsStorageEmptyAndCodeVerbatim() async throws {
        // Given edge 拒绝配对码
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 400, json: ["code": "PAIR_CODE_INVALID", "message": "pairing code rejected"])
        }
        let store = InMemorySecureStore()
        let tokens = try makeProvider(store)
        let client = PairingClient(http: URLSessionHttpClient(), sink: tokens)

        // When / Then 失败，且错误码原样带回、存储里一个字都没有（保留可改）
        let error = await captureTransportError {
            _ = try await client.pair(baseURL: baseURL, code: "WRONG", name: "iPhone")
        }
        XCTAssertEqual(error, .badResponse("PAIR_CODE_INVALID"))
        XCTAssertNil(tokens.current)
        XCTAssertEqual(store.dump, [:])
    }

    func testPairingRateLimitIsReportedVerbatimAndNotRetried() async throws {
        // Given edge 报限流
        let (server, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 429, json: ["code": "PAIR_RATE_LIMITED", "message": "too many failed pairing attempts"])
        }
        let store = InMemorySecureStore()
        let tokens = try makeProvider(store)
        let client = PairingClient(http: URLSessionHttpClient(), sink: tokens)

        // When / Then 明确报限流，且**只请求一次**（配对码一次性，不重试）
        let error = await captureTransportError {
            _ = try await client.pair(baseURL: baseURL, code: "ABCD", name: "iPhone")
        }
        XCTAssertEqual(error, .badResponse("PAIR_RATE_LIMITED"))
        XCTAssertEqual(server.requestCount, 1)
        XCTAssertEqual(store.dump, [:])
    }

    func testPairingRejectsMalformedSuccessPayload() async throws {
        // Given edge 返回 200 却缺 secret
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 200, json: ["deviceId": "dev_1", "scopes": ["read"]])
        }
        let store = InMemorySecureStore()
        let tokens = try makeProvider(store)
        let client = PairingClient(http: URLSessionHttpClient(), sink: tokens)

        // When / Then 判为协议错误（不把坏数据当成功），且不落库
        let error = await captureTransportError {
            _ = try await client.pair(baseURL: baseURL, code: "ABCD", name: "iPhone")
        }
        guard case .badResponse(let text)? = error else {
            return XCTFail("期望 badResponse，实际 " + String(describing: error))
        }
        XCTAssertTrue(text.hasPrefix("PAIR_RESPONSE_INVALID"), "实际：" + text)
        XCTAssertEqual(store.dump, [:])
    }

    func testPairingNormalizesTrailingSlashForBothRequestAndStorage() async throws {
        // Given 用户输入带尾斜杠的地址
        let (server, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 200, json: ["deviceId": "dev_1", "secret": "s3cr3t"])
        }
        let store = InMemorySecureStore()
        let tokens = try makeProvider(store)
        let client = PairingClient(http: URLSessionHttpClient(), sink: tokens)

        // When 用 "地址/" 配对
        let outcome = try await client.pair(baseURL: baseURL + "/", code: "ABCD", name: "iPhone")

        // Then 请求路径没有双斜杠，绑定地址是规范化后的值
        XCTAssertEqual(server.requests.first?.path, "/pair/redeem")
        XCTAssertEqual(outcome.credential.origin.value, "http://127.0.0.1:" + String(DshtOrigin.parse(baseURL)?.port ?? 0))
        XCTAssertEqual(tokens.boundOrigin, DshtOrigin.parse(baseURL))
    }

    func testPairingNetworkFailureIsUnreachableNotSuccess() async throws {
        // Given 一个没有服务的端口
        let store = InMemorySecureStore()
        let tokens = try makeProvider(store)
        let client = PairingClient(http: URLSessionHttpClient(), sink: tokens)

        // When / Then 给出 unreachable，不抛异常到 UI、不伪装成功
        let error = await captureTransportError {
            _ = try await client.pair(baseURL: "http://127.0.0.1:1", code: "ABCD", name: "iPhone")
        }
        guard case .unreachable? = error else {
            return XCTFail("期望 unreachable，实际 " + String(describing: error))
        }
        XCTAssertEqual(store.dump, [:])
    }

    func testPairingRejectsInvalidBaseURLBeforeSendingAnything() async throws {
        // Given 一个记录调用的 HTTP 缝
        let recorder = RecordingHttpClient()
        let store = InMemorySecureStore()
        let tokens = try makeProvider(store)
        let client = PairingClient(http: recorder, sink: tokens)

        // When 用不是绝对 http(s) 的地址配对
        let error = await captureTransportError {
            _ = try await client.pair(baseURL: "not-a-url", code: "ABCD", name: "iPhone")
        }

        // Then 直接拒绝，**HTTP 层零调用**（不把令牌/配对码发往一个解析不出的地址）
        guard case .badResponse(let text)? = error else {
            return XCTFail("期望 badResponse，实际 " + String(describing: error))
        }
        XCTAssertTrue(text.hasPrefix("PAIR_ORIGIN_INVALID"), "实际：" + text)
        XCTAssertEqual(recorder.callCount, 0)
        XCTAssertEqual(store.dump, [:])
    }
}
