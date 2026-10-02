import Foundation

/// HTTP 面：一个可注入的缝。
///
/// 为什么是可注入的协议而不是直接调 URLSession：
///   1. 生产实现 URLSessionHttpClient 是唯一碰网络的地方；
///   2. 测试要能断言**"连请求都没发出去"**（跨源拒绝、未配对不建客户端）——
///      在 HTTP 层的缝上数调用次数，比在真服务器上数收到的请求更强：后者只能证明"没收到"，
///      前者证明"没有发出"。
public protocol HttpClient: Sendable {
    func send(_ request: DshtRequest) async throws -> DshtResponse
}

/// 一次 HTTP 请求（与传输层无关的纯数据）。
public struct DshtRequest: Sendable, Equatable {
    public let method: String
    public let url: URL
    public let headers: [String: String]
    public let body: Data?

    public init(method: String, url: URL, headers: [String: String] = [:], body: Data? = nil) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
    }
}

/// 一次 HTTP 响应。头名统一小写（header(_:) 做大小写不敏感查询）。
public struct DshtResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    public func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }

    public var bodyText: String { String(decoding: body, as: UTF8.self) }
}

/// 生产 HTTP 实现：URLSession + **ephemeral** 配置。
///
/// ephemeral 是刻意的：设备令牌与 /v1 数据不进磁盘缓存、不带 cookie —— 与
/// "凭据不写普通缓存"同一条纪律。
public struct URLSessionHttpClient: HttpClient {
    private let session: URLSession

    public init(timeout: TimeInterval = 15) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        self.session = URLSession(configuration: configuration)
    }

    public func send(_ request: DshtRequest) async throws -> DshtResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as TransportError {
            throw error
        } catch {
            throw TransportError.unreachable(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw TransportError.badResponse("响应不是 HTTP 响应")
        }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String {
                headers[name.lowercased()] = value
            }
        }
        return DshtResponse(status: http.statusCode, headers: headers, body: data)
    }
}
