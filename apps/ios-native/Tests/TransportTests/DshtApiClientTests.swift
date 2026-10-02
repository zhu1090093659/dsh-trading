import XCTest
import DshTradingContract
@testable import DshTradingTransport

/// /a0 与 /v1 客户端：真 HTTP 服务器验令牌与解析；HTTP 缝验"跨源时零调用"。
final class DshtApiClientTests: TransportTestCase {
    private func client(baseURL: String, token: String?, http: any HttpClient) throws -> DshtApiClient {
        let origin = try XCTUnwrap(DshtOrigin.parse(baseURL), "测试基址应当可解析：" + baseURL)
        return DshtApiClient(origin: origin, tokens: SpyTokenProvider(token), http: http)
    }

    func testRequestCarriesTwoSegmentBearerToken() async throws {
        // Given 一个正常应答的 bot
        let (server, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 200, json: ["ok": true, "atMs": 1, "device": "dev_1"])
        }
        let token = try XCTUnwrap(DeviceToken.authorization(deviceId: "dev_1", secret: "s3cr3t"))
        let apiClient = try client(baseURL: baseURL, token: token, http: URLSessionHttpClient())

        // When 取一次心跳
        let ok = try await apiClient.ping()

        // Then 服务器真的收到了两段式令牌（只发 secret 会被 edge 判 401），路径是 /a0/ping
        XCTAssertTrue(ok)
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request.headers["authorization"], "Bearer dev_1.s3cr3t")
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.path, "/a0/ping")
    }

    func testA0StatusParsesKillStateAndDropsUnknownScopes() async throws {
        // Given 服务端声明 read/control 与一个认不出的平面
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(
                status: 200,
                json: [
                    "ok": true,
                    "state": ["killed": true, "paused": false, "reason": "ops", "atMs": 5],
                    "device": "dev_1",
                    "scopes": ["control", "bogus-plane", "read"],
                ]
            )
        }
        let apiClient = try client(baseURL: baseURL, token: "Bearer dev_1.s3cr3t", http: URLSessionHttpClient())

        // When 取 A0 状态
        let status = try await apiClient.a0Status()

        // Then kill 事实原样带出；未知平面**不授予**（解码在 Contract，未知 scope 丢弃）
        XCTAssertTrue(status.ok)
        XCTAssertTrue(status.state.killed)
        XCTAssertFalse(status.state.paused)
        XCTAssertEqual(status.state.reason, "ops")
        XCTAssertEqual(status.state.atMs, 5)
        XCTAssertEqual(status.device, "dev_1")
        XCTAssertEqual(status.scopes, [.control, .read])
        XCTAssertTrue(status.hasControl)
    }

    func testA0StatusWithMalformedStateThrowsInsteadOfAssumingNotKilled() async throws {
        // Given state 里缺 killed（读不到刹车状态）
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 200, json: ["ok": true, "state": ["paused": false], "device": "d", "scopes": []])
        }
        let apiClient = try client(baseURL: baseURL, token: "Bearer dev_1.s3cr3t", http: URLSessionHttpClient())

        // When / Then 抛错，**不**默认成 killed=false（默认 false 等于把"读不到刹车"当成"没有刹车"）
        let error = await captureTransportError { _ = try await apiClient.a0Status() }
        guard case .badResponse(let text)? = error else {
            return XCTFail("期望 badResponse，实际 " + String(describing: error))
        }
        XCTAssertTrue(text.hasPrefix("A0_STATUS_INVALID"), "实际：" + text)
    }

    func testUnauthorizedClearsLocalTokenAndMapsToUnauthorized() async throws {
        // Given bot 拒绝令牌
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 401, json: ["code": "EDGE_UNAUTHORIZED", "message": "invalid device token"])
        }
        let tokens = SpyTokenProvider("Bearer dev_1.bad")
        let origin = try XCTUnwrap(DshtOrigin.parse(baseURL))
        let apiClient = DshtApiClient(origin: origin, tokens: tokens, http: URLSessionHttpClient())

        // When / Then 401 映射成 unauthorized，并且**本地令牌被清掉**（回到未配对，不再拿旧令牌重试）
        let error = await captureTransportError { _ = try await apiClient.a0Status() }
        XCTAssertEqual(error, .unauthorized(code: "EDGE_UNAUTHORIZED", message: "invalid device token"))
        XCTAssertEqual(tokens.forgets, 1)
        XCTAssertNil(tokens.current)
    }

    func testScopeRequiredCarriesTheRequiredPlane() async throws {
        // Given bot 报缺 control 作用域
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(
                status: 403,
                json: ["code": "EDGE_SCOPE_REQUIRED", "message": "device lacks scope control", "required": "control"]
            )
        }
        let apiClient = try client(baseURL: baseURL, token: "Bearer dev_1.s3cr3t", http: URLSessionHttpClient())

        // When / Then 缺哪个平面就带回哪个（UI 才能解释"为什么不能做"）
        let error = await captureTransportError { _ = try await apiClient.a0Status() }
        XCTAssertEqual(error, .scopeRequired(required: .control))
    }

    func testClientTooOldMaps426() async throws {
        // Given bot 要求升级
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 426, json: ["code": "CLIENT_TOO_OLD", "message": "client is missing required capabilities"])
        }
        let apiClient = try client(baseURL: baseURL, token: "Bearer dev_1.s3cr3t", http: URLSessionHttpClient())

        // When / Then 426 原样上报（客户端不自行判定兼容性）
        let error = await captureTransportError { _ = try await apiClient.cards(clientCaps: []) }
        XCTAssertEqual(error, .clientTooOld(status: 426, code: "CLIENT_TOO_OLD"))
    }

    func testCrossOriginRequestThrowsOriginNotBoundAndNeverTouchesHttpLayer() async throws {
        // Given 一个绑定 127.0.0.1:3081 的客户端 + 记录调用的 HTTP 缝
        let recorder = RecordingHttpClient()
        let apiClient = DshtApiClient(origin: .loopback, tokens: SpyTokenProvider("Bearer dev_1.s3cr3t"), http: recorder)

        // When 请求一个指向别的 origin 的绝对 URL
        let error = await captureTransportError {
            _ = try await apiClient.request(method: "GET", path: "http://evil.example.com/v1/cards")
        }

        // Then 抛 originNotBound，且 **HTTP 层一次都没被调用**（令牌根本没离开进程）
        XCTAssertEqual(
            error,
            .originNotBound(expected: "http://127.0.0.1:3081", actual: "http://evil.example.com:80")
        )
        XCTAssertEqual(recorder.callCount, 0)
    }

    func testSameHostDifferentPortIsAlsoRejectedWithoutSending() async throws {
        // Given 同一个 host、不同端口的地址
        let recorder = RecordingHttpClient()
        let apiClient = DshtApiClient(origin: .loopback, tokens: SpyTokenProvider("Bearer dev_1.s3cr3t"), http: recorder)

        // When / Then 端口不同就是不同的 origin，一样拒绝且零调用
        let error = await captureTransportError {
            _ = try await apiClient.request(method: "GET", path: "http://127.0.0.1:9999/v1/cards")
        }
        XCTAssertEqual(
            error,
            .originNotBound(expected: "http://127.0.0.1:3081", actual: "http://127.0.0.1:9999")
        )
        XCTAssertEqual(recorder.callCount, 0)
    }

    func testUnpairedClientSendsNothing() async throws {
        // Given 没有令牌的客户端 + 一个真服务器
        let (server, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 200, json: ["ok": true])
        }
        let apiClient = try client(baseURL: baseURL, token: nil, http: URLSessionHttpClient())

        // When / Then 直接判 unreachable，且服务器**一个请求都没收到**
        let error = await captureTransportError { _ = try await apiClient.ping() }
        guard case .unreachable? = error else {
            return XCTFail("期望 unreachable，实际 " + String(describing: error))
        }
        XCTAssertEqual(server.requestCount, 0)
    }

    func testCardsSendsClientCapsHeaderAndParsesPageWithUnknownEnumPreserved() async throws {
        // Given 服务端回一页卡片：含一个未知 cardType（封闭枚举的未知值必须活下来）
        let (server, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(
                status: 200,
                json: [
                    "cards": [
                        [
                            "cardId": "c1",
                            "cardType": "desk-summary",
                            "revision": 3,
                            "fallbackText": "兜底",
                            "fields": [["key": "equity", "label": "权益", "kind": "currency", "value": 1234.5]],
                            "actions": [["kind": "ack", "label": "已读"]],
                        ],
                        [
                            "cardId": "c2",
                            "cardType": "future-card-type",
                            "revision": 1,
                            "fallbackText": "未知类型",
                        ],
                    ],
                    "truncated": false,
                    "caps": ["cards.v1"],
                    "downgraded": ["future.thing"],
                ],
                headers: ["x-dsht-caps": "cards.v1"]
            )
        }
        let apiClient = try client(baseURL: baseURL, token: "Bearer dev_1.s3cr3t", http: URLSessionHttpClient())

        // When 取卡片（带上客户端能力）
        let page = try await apiClient.cards(clientCaps: TransportHandshake.clientCaps)

        // Then 请求头带能力；卡片按契约解码：数字标量搬成文本、未知类型保留为 String
        XCTAssertEqual(
            server.requests.first?.headers["x-dsht-caps"],
            "cards.v1,confirm.biometric,offline.staleness"
        )
        XCTAssertEqual(page.cards.count, 2)
        XCTAssertEqual(page.cards.first?.cardType, "desk-summary")
        XCTAssertEqual(page.cards.first?.revision, 3)
        XCTAssertEqual(page.cards.first?.fields.first?.value, "1234.5")
        XCTAssertEqual(page.cards.first?.actions.first?.kind, "ack")
        XCTAssertEqual(page.cards.last?.cardType, "future-card-type")
        XCTAssertEqual(page.caps, ["cards.v1"])
        XCTAssertEqual(page.downgraded, ["future.thing"])
    }

    func testCommandPostsActionAndClientRequestId() async throws {
        // Given 一个接受命令的 bot
        let (server, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 200, json: ["clientRequestId": "req-1", "replayed": false, "result": "ok"])
        }
        let apiClient = try client(baseURL: baseURL, token: "Bearer dev_1.s3cr3t", http: URLSessionHttpClient())

        // When 发一个命令
        let receipt = try await apiClient.command(action: .ack, params: ["note": "ok"], clientRequestId: "req-1")

        // Then 打到 /v1/commands，体里是契约要求的三个字段，回执原样带回
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/v1/commands")
        XCTAssertEqual(request.headers["authorization"], "Bearer dev_1.s3cr3t")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(body["clientRequestId"] as? String, "req-1")
        XCTAssertEqual(body["action"] as? String, "ack")
        XCTAssertEqual((body["params"] as? [String: String])?["note"], "ok")
        let receiptObject = try XCTUnwrap(JSONSerialization.jsonObject(with: receipt) as? [String: Any])
        XCTAssertEqual(receiptObject["clientRequestId"] as? String, "req-1")
    }
}
