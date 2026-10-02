import Foundation

/// Transport/ —— 网络、配对与设备鉴权（IOS-2）。
///
/// **写作用域：apps/ios-native/Sources/Transport/**（本文件由 IOS-1 建立后由 IOS-2 认领）。
///
/// 边界与纪律：
///   - 只依赖 Sources/Contract/**（DshTradingContract）与 Foundation/Security，
///     **不自行定义版本/能力/scope 语义**，也不下沉 ids.ts 语义（客户端不自行发号）。
///   - 端点清单以服务端为唯一权威（packages/tradectl/src/edge.ts 与 api-v1.ts），本层不造新端点。
///   - 传输面清单（端点与类型）的家是 apps/ios-native/README.md §1「各层事实之家」的传输面一行，
///     并以本目录源码为准（代码即判据）。
///   - 两条硬规则（令牌只发绑定 origin、配对永不签发 control）见 README.md §6 不变量 #4 与 #5。
///
/// 本目录的文件：
///   DshtOrigin          配对绑定的 origin（scheme/host/port 三元组）+ 基址规范化
///   HttpClient          HTTP 缝（URLSessionHttpClient 是唯一碰网络的实现）
///   TransportError      失败词汇 + 非穷尽友好的 kind 分类
///   ServerFailure       服务端错误体解析与 401/403/426 映射
///   SecureStore         SecureStore 协议 + KeychainSecureStore + 测试用内存假件
///   DeviceToken         两段式令牌 deviceId.secret 的组装与切分
///   Credential          StoredCredential（含绑定 origin、脱敏）+ CredentialVault（fail-closed）
///   TokenProvider       令牌提供者协议 + KeychainTokenProvider
///   PairingClient       POST /pair/redeem（成功才落库）
///   DshtApiClient       /a0 与 /v1 客户端（origin 守卫 + 401/403 映射）
///   TransportSession    会话状态（未配对是明确状态）+ 版本能力协商
///
/// 一条**只增**的修订（2026-10-02，经 Lead 批准）：TransportError 增加
/// unauthorized(code:message:)。原有五个 case 逐字保留。消费方请优先用
/// TransportError.kind（封闭、不带负载）分类，避免被迫写 default 吞掉未知分支。
public protocol TransportHealthReporting: Sendable {
    /// 当前是否处于只读（切换期 / 未配对）。
    var isReadOnly: Bool { get }
}
