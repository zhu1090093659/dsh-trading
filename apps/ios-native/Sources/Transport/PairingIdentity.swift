import Foundation

/// 配对身份 = **绑定 origin + 配对代际（epoch）**。
///
/// 为什么必须是两件事：origin 只回答"令牌该发给谁"，代际回答"这个客户端还是不是当前那一次配对的"。
/// 只看 origin 时，重新配对到**同一个** origin（服务端重发凭据、同一实例换设备）之后的旧客户端
/// 依然算"绑定一致"；而进程里长期持有的旧客户端（App 的装配链在重建前一直握着它）会跨过这次
/// 重新配对继续发请求。每次配对成功 epoch 前移一次，旧客户端在发请求前发现自己的代际已过期
/// ⇒ 直接失败，**不发请求**（不是"发一个会被服务端拒绝的请求"）。
///
/// epoch 只在进程内递增：它是"本次进程里发生过几次配对"的计数器，不落库、也不要求跨重启一致 ——
/// 重启后新客户端取到的就是当时的当前代际。所以它不进 StoredCredential 的编码格式。
///
/// 这是 IOS-7 / IOS-8 共用的**同一个**"配对身份"概念（One home per fact）：
/// 跨源缓存污染与令牌跨源外发都收敛到这里，不各自另造一份。
public struct PairingIdentity: Equatable, Hashable, Sendable, CustomStringConvertible {
    public let origin: DshtOrigin
    /// 配对代际：每成功配对一次 +1。0 表示"本进程还没配对过"。
    public let epoch: Int

    public init(origin: DshtOrigin, epoch: Int) {
        self.origin = origin
        self.epoch = epoch
    }

    /// 规范字符串形式（用于诊断；不含任何凭据材料）。
    public var value: String { origin.value + "#" + String(epoch) }

    public var description: String { value }
}
