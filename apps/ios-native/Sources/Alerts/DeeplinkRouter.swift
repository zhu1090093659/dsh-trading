import Foundation
import DshTradingContract

/// 打开应用内目标的端口（真实实现是 App 的路由器；测试用假件记录"打开了什么"）。
public protocol DeeplinkOpening: Sendable {
    func open(screen: DeeplinkScreen, id: String?)
}

/// 深链路由：**只认 Contract 的封闭集合**（parseDeeplink）。
///
/// 未知 screen / 外部 scheme 一律 .rejected，**绝不"尽力跳转"**——推送来自进程之外，
/// 一条被改写的深链就是一次钓鱼跳转的机会。
public enum DeeplinkRouter {
    @discardableResult
    public static func route(_ url: String, opener: any DeeplinkOpening) -> DeeplinkResult {
        let result = parseDeeplink(url)
        if case .ok(let screen, let id) = result {
            opener.open(screen: screen, id: id)
        }
        return result
    }
}
