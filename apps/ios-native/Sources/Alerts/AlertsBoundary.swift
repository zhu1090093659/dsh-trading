import Foundation
import DshTradingContract

/// Alerts/ —— 告警闭环、推送载荷与设备能力（IOS-5）。
///
/// **写作用域：apps/ios-native/Sources/Alerts/**（本文件由 IOS-1 建立后由 IOS-5 认领）。
///
/// 边界与纪律：
///   - 推送载荷校验与深链开放集**已在 Sources/Contract/ContractPush.swift 与
///     ContractOffline.swift 冻结**（唯一入口 acceptedPush）；本目录只调用，不放宽。
///   - 确认档位表（Contracts 的 actionConfirm / confirmLevel）是**判据的唯一之家**；
///     本目录只把档位翻成"要不要发出去"，不自行定义哪个动作要生物识别。
///   - 生物识别**不替代服务端授权与风控**：通过闸门只表示"动作可以发出去"。
///   - 本目录不碰观测面：推送注册状态不影响 /v1 观测路径。
///
/// 本目录的文件：
///   PushIntake           APNs userInfo → PushPayload（唯一入口 acceptedPush）
///   AlertPolicy          静默时段/锁屏档位/用户偏好 + shouldInterrupt 合成
///   AlertLifecycle       闭环状态机：发生/重复/确认/恢复（确认≠恢复，append-only 历史）
///   AlertNotification    通知端口、类目（PushAction ∩ ActionKind）、锁屏脱敏正文、前台强度
///   DeeplinkRouter       深链开放集路由（未知 screen 拒绝）
///   AlertsConfirmationGate  ConfirmationGate 实现（生物识别 fail-closed）
///   AlertsCoordinator    接收流水总装
///   SystemAdapters       UNUserNotificationCenter / LocalAuthentication 的真实适配
public protocol AlertSink: Sendable {
    func deliver(_ payload: PushPayload) -> Bool
}
