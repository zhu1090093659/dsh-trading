import Foundation
import DshTradingContract

/// APNs 载荷的接收入口。
///
/// **判据一个都不在这里**：结构 + 语义 + 深链开放集全部由 Contract 的唯一入口
/// acceptedPush 判定（= 反序列化 + validatePushPayload + parseDeeplink）。
/// 本类型只做一件事：把 APNs 的 userInfo 里的业务段抽出来，交给那个入口。
/// 抽不出来 / 判不合法 ⇒ **drop**（不"尽力解析"、不猜默认值）。
///
/// 写作用域：apps/ios-native/Sources/Alerts/**
public enum PushIntake {
    /// APNs 自定义段的键名（aps 是系统段，业务段放在这里）。
    public static let payloadKey = "dsht"

    /// 从 APNs userInfo 接收。支持两种形态：
    ///   - 嵌套：{ "aps": {...}, "dsht": {kind, severity, ...} }（推荐，默认）
    ///   - 扁平：{ "aps": {...}, kind: ..., severity: ... }（去掉 aps 后即业务段）
    public static func accept(apnsUserInfo userInfo: [AnyHashable: Any]) -> PushPayload? {
        let business: [AnyHashable: Any]
        if let nested = userInfo[payloadKey] as? [AnyHashable: Any] {
            business = nested
        } else {
            var flat = userInfo
            flat.removeValue(forKey: "aps")
            business = flat
        }
        guard let object = jsonObject(business), JSONSerialization.isValidJSONObject(object) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return accept(json: data)
    }

    /// 从 JSON 字节接收。**唯一的判定入口就是 Contract 的 acceptedPush。**
    public static func accept(json data: Data) -> PushPayload? {
        acceptedPush(data)
    }

    /// 把 userInfo 收敛成 JSON 可序列化的对象（键必须是 String；值只接受 JSON 类型）。
    /// 认不出的值一律不放行 —— 推送载荷来自进程之外，不能假设它的形状。
    static func jsonObject(_ value: Any) -> Any? {
        if let dictionary = value as? [AnyHashable: Any] {
            var result: [String: Any] = [:]
            for (key, entry) in dictionary {
                guard let name = key as? String, let converted = jsonObject(entry) else { return nil }
                result[name] = converted
            }
            return result
        }
        if let array = value as? [Any] {
            var result: [Any] = []
            for entry in array {
                guard let converted = jsonObject(entry) else { return nil }
                result.append(converted)
            }
            return result
        }
        if value is NSNull { return NSNull() }
        if let text = value as? String { return text }
        if let number = value as? NSNumber { return number }
        return nil
    }
}
