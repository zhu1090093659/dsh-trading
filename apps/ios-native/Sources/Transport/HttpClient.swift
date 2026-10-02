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

/// 生产 HTTP 实现：URLSession + **ephemeral** 配置 + **跨源不跟随重定向**的 delegate。
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
        // delegate 必须真的挂上：URLSession(configuration:) 不设 delegate 时，跨源 30x
        // 会被**默认跟随**——请求（以及其 Authorization 头）就被发去了另一个 origin，
        // 而 DshtApiClient 的 origin 守卫只看原始 URL。显式挂载是本层的事实，不靠"默认行为恰好如何"。
        self.session = URLSession(
            configuration: configuration,
            delegate: RedirectPolicyDelegate(),
            delegateQueue: nil
        )
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

/// 重定向策略：**跨源一律不跟随**，同源才跟。
///
/// 跨源时返回 nil（"不重定向"）⇒ URLSession 把**原始的 3xx 响应**交给上层：
///   1. 新 origin 一个字节都收不到（比"跟过去但剥掉 Authorization"更没有可泄露面）；
///   2. 3xx 非 200 ⇒ DshtApiClient 走 ServerFailure 映射，如实报错，不伪装成功。
///
/// 不返回同一份 newRequest 是刻意的：那会让 URLSession 在跟随同源重定向时重新走一遍
/// 头合并，Authorization 的去留取决于它的内部规则。这里每个决定都用**显式请求**
/// （BaseURL + 自己的头），"令牌带不带到新 origin"是一个本地可读的事实。
final class RedirectPolicyDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        redirect(from: task.originalRequest, willPerform: response, newRequest: request, completionHandler: completionHandler)
    }

    /// 判定与返回值的**唯一**实现。
    private func redirect(
        from original: URLRequest?,
        willPerform response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        // 原始请求地址与重定向目标地址都可能是 nil（URLRequest.url 是可选的）：
        // 任一取不出来 ⇒ 当作跨源，不跟随（fail-closed）。
        guard let originURL = response.url ?? original?.url, let origin = DshtOrigin(url: originURL),
              let redirectURL = request.url, let redirectOrigin = DshtOrigin(url: redirectURL),
              redirectOrigin == origin
        else {
            // 跨源（含解析不出目标的 scheme/端口）⇒ 不跟随，把 3xx 原样交回上层。
            completionHandler(nil)
            return
        }
        // 同源：显式构造请求——只保留方法/请求体，**不重放 Authorization**（同源重定向也未必还是同一个资源），
        // 其余头由 URLSession 按 HTTP 语义处理。
        var explicit = URLRequest(url: redirectURL)
        explicit.httpMethod = original?.httpMethod ?? "GET"
        explicit.httpBody = original?.httpBody
        completionHandler(explicit)
    }
}
