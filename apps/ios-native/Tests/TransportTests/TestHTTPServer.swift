import Foundation
import Network

/// 测试用**真 HTTP 服务器**（不是 mock）：监听回环端口、记录收到的请求、按请求应答。
///
/// 为什么必须是真的：配对与 /v1 的判据里有一条是"令牌到底发出去了没有、发成了什么形状"，
/// 只有真实字节能证明（先例：apps/mobile 的配对用例起真 http.createServer，见 pairing.test.ts）。
/// 本类型不参与任何业务判定 —— 它只是把那句话放回网络层去验。
final class TestHTTPServer: @unchecked Sendable {
    struct Request: Sendable {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    struct Reply: Sendable {
        let status: Int
        let headers: [String: String]
        let body: Data

        init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
            self.status = status
            self.headers = headers
            self.body = body
        }

        /// JSON 应答；默认 `content-type: application/json`。
        init(status: Int, json: Any, headers: [String: String] = [:]) {
            let data = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
            var merged = headers
            if merged["content-type"] == nil { merged["content-type"] = "application/json" }
            self.init(status: status, headers: merged, body: data)
        }
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "dsht.tests.http")
    private let lock = NSLock()
    private var received: [Request] = []
    private var readyContinuation: CheckedContinuation<UInt16, Error>?
    private let handler: @Sendable (Request) -> Reply

    init(handler: @escaping @Sendable (Request) -> Reply) throws {
        self.handler = handler
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        self.listener = try NWListener(using: parameters, on: .any)
    }

    var requests: [Request] {
        lock.lock(); defer { lock.unlock() }
        return received
    }

    var requestCount: Int {
        lock.lock(); defer { lock.unlock() }
        return received.count
    }

    /// 启动并等到 `.ready` 之后返回端口 —— 事件驱动，**不 sleep**。
    func start() async throws -> UInt16 {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                let port = self.listener.port?.rawValue ?? 0
                self.resumeReady(with: .success(port))
            case .failed(let error):
                self.resumeReady(with: .failure(error))
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            self.receive(on: connection, buffer: Data())
        }
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            readyContinuation = continuation
            lock.unlock()
            listener.start(queue: queue)
        }
    }

    func stop() {
        listener.cancel()
    }

    static func baseURL(port: UInt16) -> String {
        "http://127.0.0.1:" + String(port)
    }

    private func resumeReady(with result: Result<UInt16, Error>) {
        lock.lock()
        let continuation = readyContinuation
        readyContinuation = nil
        lock.unlock()
        switch result {
        case .success(let port): continuation?.resume(returning: port)
        case .failure(let error): continuation?.resume(throwing: error)
        }
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { connection.cancel(); return }
            var accumulated = buffer
            if let data { accumulated.append(data) }
            if let request = TestHTTPServer.parse(accumulated) {
                self.lock.lock()
                self.received.append(request)
                self.lock.unlock()
                self.respond(on: connection, reply: self.handler(request))
                return
            }
            if isComplete || error != nil {
                connection.cancel()
                return
            }
            self.receive(on: connection, buffer: accumulated)
        }
    }

    private func respond(on connection: NWConnection, reply: Reply) {
        var head = "HTTP/1.1 " + String(reply.status) + " " + TestHTTPServer.reason(reply.status) + "\r\n"
        var headers = reply.headers
        if headers["content-type"] == nil { headers["content-type"] = "application/json" }
        headers["content-length"] = String(reply.body.count)
        headers["connection"] = "close"
        for (name, value) in headers {
            head += name + ": " + value + "\r\n"
        }
        head += "\r\n"
        var payload = Data(head.utf8)
        payload.append(reply.body)
        connection.send(content: payload, completion: .contentProcessed { _ in connection.cancel() })
    }

    private static func parse(_ data: Data) -> Request? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let headerText = String(data: data[data.startIndex..<headerEnd.lowerBound], encoding: .utf8) else { return nil }
        var lines = headerText.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let parts = lines.removeFirst().split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        let bodyStart = headerEnd.upperBound
        let contentLength = Int(headers["content-length"] ?? "0") ?? 0
        let available = data.distance(from: bodyStart, to: data.endIndex)
        guard available >= contentLength else { return nil }
        let body = data.subdata(in: bodyStart..<data.index(bodyStart, offsetBy: contentLength))
        return Request(method: String(parts[0]), path: String(parts[1]), headers: headers, body: body)
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 426: return "Upgrade Required"
        case 429: return "Too Many Requests"
        default: return "Status"
        }
    }
}
