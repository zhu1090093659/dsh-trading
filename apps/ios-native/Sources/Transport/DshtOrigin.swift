import Foundation

/// 配对绑定的 origin：scheme + host + port 三元组（**不是**字符串拼接）。
///
/// 一条来自桌面壳的教训：桌面壳曾因"给所有请求都注入凭据"把设备密钥发给了无关实例。
/// 因此"令牌属于哪个实例"必须是一条**可判定的相等事实**，而不是"调用方记得别发错"。
/// 这里把 origin 建模成三元组，DshtApiClient 在每次发请求**之前**断言目标 origin 相等。
public struct DshtOrigin: Equatable, Hashable, Sendable, CustomStringConvertible {
    public let scheme: String
    public let host: String
    public let port: Int

    public init(scheme: String, host: String, port: Int) {
        self.scheme = scheme.lowercased()
        self.host = host.lowercased()
        self.port = port
    }

    /// 从 URL 取 origin。缺 scheme/host、或 scheme 不是 http(s) 时返回 nil（fail-closed：
    /// 解析不出来的地址不许被当成"某个 origin"，否则跨源守卫会静默失效）。
    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host?.lowercased(),
              !host.isEmpty
        else { return nil }
        self.init(scheme: scheme, host: host, port: components.port ?? DshtOrigin.defaultPort(forScheme: scheme))
    }

    public static func defaultPort(forScheme scheme: String) -> Int {
        scheme.lowercased() == "https" ? 443 : 80
    }

    /// 规范化用户输入的基址：去首尾空白、去尾部斜杠。
    /// 配对请求与落库**必须用同一个值**，否则"绑定地址"和"实际请求地址"会差一个斜杠。
    public static func normalizeBaseURL(_ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }

    /// 解析用户输入的基址；非法 / 非 http(s) / 缺主机时返回 nil。
    public static func parse(_ raw: String) -> DshtOrigin? {
        let normalized = normalizeBaseURL(raw)
        guard !normalized.isEmpty, let url = URL(string: normalized) else { return nil }
        return DshtOrigin(url: url)
    }

    /// origin 的规范字符串形式（用于错误信息与落库）。
    public var value: String {
        scheme + "://" + host + ":" + String(port)
    }

    public var description: String { value }

    /// 把路径解析到本 origin 上。
    ///
    /// - 相对路径（/v1/cards）落在本 origin；
    /// - **绝对 URL 会逃逸到别的 origin** —— 这正是跨源守卫要拦下的情形。
    ///   守卫必须可达：apps/mobile 的跨源守卫曾因字符串拼接而成为永不触发的死代码。
    public func url(_ path: String) -> URL? {
        guard let base = URL(string: value + "/") else { return nil }
        return URL(string: path, relativeTo: base)?.absoluteURL
    }
}
