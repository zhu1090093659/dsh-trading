import Foundation
import DshTradingContract
import DshTradingDomain

/// 生物识别的结论。**unavailable 与 failed 分开**：前者是"这台设备做不了"，
/// 后者是"做了但没过"——两者对 UI 的话术不同，但**都不放行**。
public enum BiometricOutcome: Equatable, Sendable {
    case success
    case failed
    case canceled
    case unavailable(reason: String)
}

/// 设备生物识别的可注入端口（真实实现见 SystemAdapters.swift 的 LocalAuthenticationBiometrics）。
public protocol BiometricAuthenticating: Sendable {
    func authenticate(reason: String) async -> BiometricOutcome
}

/// 确认闸门（Domain 的 ConfirmationGate 实现）。
///
/// 它只回答**"要不要把这个动作发出去"**：
///   - 生物识别通过 ≠ 动作会被执行 —— **生物识别不替代服务端授权与风控**。
///     发出去之后服务端仍按 scope 与 mandate 判；客户端这道闸门过了，服务端照样可以拒。
///   - **fail-closed**：生物识别不可用（无硬件/未录入/被策略禁用/被系统锁定）时返回
///     .unavailable，绝不降级成"点一下就过"。调用方必须把 .unavailable 当拒绝处理。
public final class AlertsConfirmationGate: ConfirmationGate, Sendable {
    private let biometrics: any BiometricAuthenticating

    public init(biometrics: any BiometricAuthenticating) {
        self.biometrics = biometrics
    }

    public func confirm(level: ConfirmLevel, reason: String) async -> ConfirmDecision {
        switch level {
        case .none:
            return .approved
        case .confirm:
            // .confirm 的界面二次确认属于 Features；闸门只负责强因子，不重复问一遍。
            return .approved
        case .biometric:
            switch await biometrics.authenticate(reason: reason) {
            case .success: return .approved
            case .failed, .canceled: return .denied
            case .unavailable(let why): return .unavailable(reason: why)
            }
        }
    }
}

/// 通知动作 → 闸门档位。档位**永远取自契约**：未知标识一律最高档 biometric（fail-closed）。
public enum AlertsGate {
    public static func level(forNotificationAction identifier: String) -> ConfirmLevel {
        confirmLevel(for: identifier)
    }
}
