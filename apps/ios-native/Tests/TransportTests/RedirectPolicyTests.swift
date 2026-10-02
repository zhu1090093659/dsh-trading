import XCTest
import DshTradingContract
@testable import DshTradingTransport

/// 重定向策略（URLSessionHttpClient 的 delegate）：**跨源一律不跟随**，同源才跟。
///
/// 为什么必须有负例：`URLSession(configuration:)` 不设 delegate 时 30x 会被默认跟随，
/// 于是"跨源连请求都不发"这条不变量在**重定向**这条路上是空的（请求连同 Authorization
/// 头一起被发去另一个 origin，而 DshtApiClient 的 origin 守卫只看原始 URL）。
/// 所以判据要落到"目标 origin 一个请求都没收到"这种网络层能证明的事实上。
final class RedirectPolicyTests: TransportTestCase {
    func testCrossOriginRedirectIsNotFollowedAndTheTargetOriginReceivesNothing() async throws {
        // Given 一个目标 origin（记录收到的请求），和把它当作 Location 的源 origin
        let (target, targetBase) = try await startServer { _ in
            TestHTTPServer.Reply(status: 200, json: ["ok": true])
        }
        let (source, sourceBase) = try await startServer { _ in
            TestHTTPServer.Reply(status: 302, headers: ["location": targetBase + "/v1/cards"])
        }
        let http = URLSessionHttpClient()
        let url = try XCTUnwrap(URL(string: sourceBase + "/v1/cards"))

        // When 请求源 origin，而它回一个跨源 302
        let response = try await http.send(
            DshtRequest(method: "GET", url: url, headers: ["authorization": "Bearer dev_1.s3cr3t"])
        )

        // Then 不跟随：原始 3xx 原样交回上层，**目标 origin 一个请求都没收到**
        // （也就是令牌没有离开源 origin —— 它连一个字节都没往新 origin 发）
        XCTAssertEqual(response.status, 302)
        XCTAssertEqual(target.requestCount, 0)
        XCTAssertEqual(source.requestCount, 1)
    }

    func testSameOriginRedirectIsFollowedAndTheFinalResponseIsUsed() async throws {
        // Given 一个同源重定向的 bot（Location 是相对路径）
        let (server, baseURL) = try await startServer { request in
            if request.path == "/a0/ping" {
                return TestHTTPServer.Reply(status: 302, headers: ["location": "/a0/redirected"])
            }
            return TestHTTPServer.Reply(status: 200, json: ["ok": true, "atMs": 7, "device": "dev_1"])
        }
        let http = URLSessionHttpClient()
        let url = try XCTUnwrap(URL(string: baseURL + "/a0/ping"))

        // When 发一次会撞上同源重定向的请求
        let response = try await http.send(DshtRequest(method: "GET", url: url))

        // Then 跟随，并且最终响应用的是重定向后的那个（不是把 302 当成结果）
        XCTAssertEqual(response.status, 200)
        XCTAssertEqual(server.requestCount, 2)
        XCTAssertEqual(server.requests.map(\.path), ["/a0/ping", "/a0/redirected"])
    }
}
