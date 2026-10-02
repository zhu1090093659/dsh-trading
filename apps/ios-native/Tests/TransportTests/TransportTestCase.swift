import XCTest
@testable import DshTradingTransport

/// Transport 用例的公共基座：起/停真 HTTP 服务器，并提供把异步失败收敛成 TransportError 的入口。
///
/// **禁 sleep**：服务器就绪用 continuation（事件驱动），重试/等待一律由网络层返回结果驱动。
class TransportTestCase: XCTestCase {
    private var servers: [TestHTTPServer] = []

    override func tearDown() {
        for server in servers { server.stop() }
        servers.removeAll()
        super.tearDown()
    }

    @discardableResult
    func startServer(
        _ handler: @escaping @Sendable (TestHTTPServer.Request) -> TestHTTPServer.Reply
    ) async throws -> (server: TestHTTPServer, baseURL: String) {
        let server = try TestHTTPServer(handler: handler)
        let port = try await server.start()
        servers.append(server)
        return (server, TestHTTPServer.baseURL(port: port))
    }

    /// 只接受 TransportError；别的错误直接判失败（避免"catch 到了什么"变成沉默通过）。
    func captureTransportError(
        _ operation: () async throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async -> TransportError? {
        do {
            try await operation()
            XCTFail("应当抛出 TransportError，但没有", file: file, line: line)
            return nil
        } catch let error as TransportError {
            return error
        } catch {
            XCTFail("抛出了非 TransportError：" + String(describing: error), file: file, line: line)
            return nil
        }
    }
}
