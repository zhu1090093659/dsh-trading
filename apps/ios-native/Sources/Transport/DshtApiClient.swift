import Foundation
import DshTradingContract

/// 带设备令牌的 /v1 与 A0 客户端。
///
/// 两条硬规则就落在这个类型里（apps/ios-native/README.md §6 不变量 #4 与 #5）：
///
/// **1. 令牌只发往配对绑定的 origin。** 每个请求先由 origin 解析出目标 URL，再断言
/// 目标 origin == 绑定 origin；不等则抛 originNotBound，且 **http.send 一次都不会被调用**。
/// 守卫必须是"可达"的：它靠 URL 解析而不是字符串拼接 —— apps/mobile 的跨源守卫曾因拼接
/// 而成为永不触发的死代码（配置之外的地址被当成 path 拼在 base 后面，origin 永远相等）。
///
/// **2. 401/403 各有明确分支。** 401（EDGE_UNAUTHORIZED）⇒ 清掉本地令牌回到未配对，
/// 抛 unauthorized；403（EDGE_SCOPE_REQUIRED / SCOPE_REQUIRED）⇒ 抛 scopeRequired(required:)；
/// 426 ⇒ clientTooOld。客户端不重试、不伪装成功、不"猜一个成功"。
///
/// **令牌的取用只有一个入口**：tokens.authorization(ifBoundTo: 绑定 origin)。
/// 无绑定的那个取令牌入口已从协议删除（IOS-8）：有绑定版本不匹配就是 nil ⇒ 抛错、不发请求，
/// 绝不回落到"拿一份令牌先发出去再说"。
public final class DshtApiClient: ObservationTransport {
    /// 创建这份客户端时的**配对身份**：绑定 origin + 配对代际。
    ///
    /// 为什么连代际一起记：重新配对到**同一个** origin 时，仅靠 origin 断言看不出"这是旧客户端"
    /// （origin 仍然相等），旧客户端就会拿新凭据继续打同一个地址 —— 那是"旧客户端还在用新身份"。
    /// 代际前移后，旧客户端的每次请求都 fail-closed。
    public let identity: PairingIdentity
    private let tokens: any TokenProvider
    private let identities: any PairingIdentityProviding
    private let http: any HttpClient

    /// 绑定 origin（配对时绑定的那个）。与令牌一起存（见 StoredCredential），调用方无法另给一个。
    public var origin: DshtOrigin { identity.origin }

    public init(origin: DshtOrigin, tokens: any TokenProvider, http: any HttpClient) {
        self.identity = PairingIdentity(origin: origin, epoch: 0)
        self.tokens = tokens
        self.identities = Self.snapshotIdentity(origin: origin)
        self.http = http
    }

    /// 常规装配入口：从提供者取**当前**配对身份建立客户端。未配对时返回 nil
    /// （不建一个没有令牌的客户端，也不发匿名请求）。
    public init?(tokens: any TokenProvider, identities: any PairingIdentityProviding, http: any HttpClient) {
        guard let identity = identities.pairingIdentity else { return nil }
        self.identity = identity
        self.tokens = tokens
        self.identities = identities
        self.http = http
    }

    /// 只认一个 origin 的静态身份来源（见上面那个 init）。
    private struct FixedIdentity: PairingIdentityProviding {
        let identity: PairingIdentity
        var pairingIdentity: PairingIdentity? { identity }
    }

    private static func snapshotIdentity(origin: DshtOrigin) -> any PairingIdentityProviding {
        FixedIdentity(identity: PairingIdentity(origin: origin, epoch: 0))
    }

    // MARK: - 发请求（唯一入口）

    /// 发一次请求：origin 守卫 → 配对代际守卫 → 注入令牌 → 发送 → 错误映射。
    ///
    /// path 既接受相对路径（/v1/cards），也接受绝对 URL —— 后者正是跨源守卫要拦下的输入，
    /// 所以守卫必须是这一层的事实，而不是"调用方约定只传相对路径"。
    public func request(
        method: String,
        path: String,
        headers: [String: String] = [:],
        body: Data? = nil
    ) async throws -> DshtResponse {
        guard let url = origin.url(path) else {
            throw TransportError.badResponse("无法构造请求 URL: " + path)
        }
        // 硬规则 1：先判 origin，再碰令牌，再发请求。
        let actual = DshtOrigin(url: url)
        guard actual == origin else {
            throw TransportError.originNotBound(
                expected: origin.value,
                actual: actual?.value ?? url.absoluteString
            )
        }
        // 配对代际守卫：重新配对之后，创建于上一次配对的客户端一律过期。
        // 只判 origin 会漏掉"重新配对到同一个 origin"——那时 origin 相等，但身份已经换了。
        guard let current = identities.pairingIdentity, current == identity else {
            throw TransportError.stalePairing(
                expected: identity.value,
                actual: identities.pairingIdentity?.value ?? "unpaired"
            )
        }
        // 令牌的**唯一**取用入口：带上绑定 origin 校验。不匹配 / 未配对 ⇒ nil ⇒ 不发请求。
        guard let authorization = tokens.authorization(ifBoundTo: origin) else {
            throw TransportError.unreachable("未配对：没有可用的设备令牌")
        }

        var requestHeaders = headers
        requestHeaders["authorization"] = authorization
        if body != nil, requestHeaders["content-type"] == nil {
            requestHeaders["content-type"] = "application/json"
        }

        let response = try await http.send(
            DshtRequest(method: method, url: url, headers: requestHeaders, body: body)
        )
        guard response.status == 200 else {
            let error = ServerFailure.map(status: response.status, body: ServerFailure.parse(response.body))
            // 401 的语义是"这份令牌不再被承认"：清掉本地令牌，让上层回到未配对（不再拿旧令牌重试）。
            if case .unauthorized = error {
                tokens.forget()
            }
            throw error
        }
        return response
    }

    // MARK: - ObservationTransport

    /// GET /a0/ping —— **这是"App 能不能看到机器人"的唯一判据**。
    public func ping() async throws -> Bool {
        let response = try await request(method: "GET", path: "/a0/ping")
        let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any]
        return object?["ok"] as? Bool ?? false
    }

    /// GET /a0/status —— **这是"机器人是否已停止"的信号**。
    ///
    /// state.killed/paused 缺失或类型不对时**抛错**，不默认成 false：
    /// 默认 false 等于把"读不到刹车状态"当成"没有刹车"（fail-open）。
    /// 拿不到就由上层渲染 .indeterminate，不许默认成 .running。
    public func a0Status() async throws -> A0Status {
        let response = try await request(method: "GET", path: "/a0/status")
        do {
            // 解码语义在 Contract（唯一一个家）：ok/state/killed/paused 缺失即抛错，
            // 未知 scope 丢弃。这里只把解码失败翻成传输错误。
            return try JSONDecoder().decode(A0Status.self, from: response.body)
        } catch {
            throw TransportError.badResponse(
                "A0_STATUS_INVALID: 响应体不符合 A0 契约（" + String(describing: error) + "）"
            )
        }
    }

    /// GET /v1/cards —— 请求头带客户端能力，响应体带服务端能力与降级项。
    public func cards(clientCaps: [String]) async throws -> CardsPage {
        var headers: [String: String] = [:]
        if !clientCaps.isEmpty {
            headers[ApiContract.capsHeader] = formatCaps(clientCaps)
        }
        let response = try await request(method: "GET", path: "/v1/cards", headers: headers)
        guard let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any] else {
            throw TransportError.badResponse("CARDS_INVALID: 响应体不是 JSON 对象")
        }
        guard let rawCards = object["cards"] as? [Any] else {
            throw TransportError.badResponse("CARDS_INVALID: 缺 cards 数组")
        }
        // 单张卡片畸形 ⇒ 丢这一张（保真：不因为一个字段把整页数据丢掉）；未知 closed 枚举
        // 由 Contract 的 Decodable 保留为 String 交给 validateCard，绝不在这里丢弃。
        let cards: [Card] = rawCards.compactMap { DshtApiClient.decodeCard($0) }
        let caps = (object["caps"] as? [String]) ?? parseCaps(response.header(ApiContract.capsHeader))
        return CardsPage(
            cards: cards,
            truncated: object["truncated"] as? Bool ?? false,
            caps: caps,
            downgraded: object["downgraded"] as? [String] ?? []
        )
    }

    /// POST /v1/commands —— 回执原样交给上层（不解析、不猜结果）。
    public func command(action: ActionKind, params: [String: String], clientRequestId: String) async throws -> Data {
        let body: [String: Any] = [
            "clientRequestId": clientRequestId,
            "action": action.rawValue,
            "params": params,
        ]
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        let response = try await request(method: "POST", path: "/v1/commands", body: data)
        return response.body
    }

    // MARK: - wire 解码

    /// 卡片解码：走 **Contract 自己的 Decodable**（§4.1 的宽松标量语义在那里，
    /// 客户端不自造第二份解码规则）。cardId 为空说明这一项根本不是卡片，丢弃该张但保留整页。
    static func decodeCard(_ value: Any) -> Card? {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let card = try? JSONDecoder().decode(Card.self, from: data),
              !card.cardId.isEmpty
        else { return nil }
        return card
    }
}
