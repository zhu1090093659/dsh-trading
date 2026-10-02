import XCTest
import DshTradingContract
@testable import DshTradingTransport

/// 能力头的**线级来源**：服务端既在响应头 \`x-dsht-caps\` 里带回能力（packages/tradectl/src/api-v1.ts
/// 的 json 分支就是这么做），也在 /v1/cards 的响应体里带 caps。
///
/// 为什么要有这一个文件：apps/mobile/src/api.ts 的第一件事就是解析响应头并把原文交给协商层
/// （\`capsHeader\` + \`parseCaps\`）；而本仓已有用例全部把 caps 写在响应体里，
/// 于是"响应头那条路"没有被任何断言钉住 —— 一旦它退化，表现是"服务端能力被当成没声明"，
/// 能力协商静默失效而**不报错**（正是本仓"未验证 ≠ 通过"针对的形态）。
final class CapsHeaderTests: TransportTestCase {
    private func makeClient(baseURL: String, token: String?) throws -> DshtApiClient {
        let origin = try XCTUnwrap(DshtOrigin.parse(baseURL))
        return DshtApiClient(origin: origin, tokens: SpyTokenProvider(token), http: URLSessionHttpClient())
    }

    func testCardsReadsServerCapsFromResponseHeaderWhenBodyOmitsThem() async throws {
        // Given 一个只在响应头里声明能力的 bot（响应体没有 caps 字段）
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(
                status: 200,
                json: ["cards": [], "truncated": false],
                headers: ["x-dsht-caps": "offline.staleness, cards.v1 ,cards.v1"]
            )
        }
        let apiClient = try makeClient(baseURL: baseURL, token: "Bearer dev_1.s3cr3t")

        // When 取卡片
        let page = try await apiClient.cards(clientCaps: TransportHandshake.clientCaps)

        // Then 能力来自响应头，且按契约读法处理：逗号切分、去空白、去重、排序
        XCTAssertEqual(page.caps, ["cards.v1", "offline.staleness"])
    }

    func testCardsDoesNotInventCapsWhenNeitherHeaderNorBodyDeclaresThem() async throws {
        // Given 一个响应头与响应体都没有能力声明的 bot
        let (_, baseURL) = try await startServer { _ in
            TestHTTPServer.Reply(status: 200, json: ["cards": [], "truncated": false])
        }
        let apiClient = try makeClient(baseURL: baseURL, token: "Bearer dev_1.s3cr3t")

        // When 取卡片
        let page = try await apiClient.cards(clientCaps: TransportHandshake.clientCaps)

        // Then 是空集合（"没声明"不等于"声明了能力"），降级项同样为空 —— 客户端不编造服务端能力
        XCTAssertEqual(page.caps, [])
        XCTAssertEqual(page.downgraded, [])
    }
}
