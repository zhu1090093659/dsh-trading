import Foundation
import Security

/// 安全存储面（冻结签名来自 INTERFACE-FREEZE.md §5）。
///
/// **凭据只进安全存储**：绝不写 UserDefaults / 文件 / 日志 —— 与本仓桌面壳
/// "凭据留在主进程、落盘 0600"同一立场，移动端用的是更强的等价物（Keychain）。
/// 平台 API 以协议注入，这样"用哪套存储"是一个显式选择，而不是藏在 import 里。
public protocol SecureStore {
    func save(_ key: String, _ value: String) throws
    func load(_ key: String) throws -> String?
    func remove(_ key: String) throws
}

/// Keychain 操作失败（携带 OSStatus，便于定位 errSecMissingEntitlement 之类的环境问题）。
public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus
    public init(status: OSStatus) { self.status = status }
}

/// 真正的设备凭据落点：iOS Keychain 通用密码项。
///
/// 一处**刻意**的选择：可访问性固定为 kSecAttrAccessibleWhenUnlockedThisDeviceOnly ——
/// 设备令牌**不随 iCloud/iTunes 备份迁移到新设备**（恢复备份到另一台机器时读不到，
/// 等于必须重新配对）。这与"凭据绑定这台设备"一致，等价于 expo-secure-store 的
/// WHEN_UNLOCKED_THIS_DEVICE_ONLY（见 apps/mobile/src/secure-store.ts 的同一裁决）。
///
/// 这里**没有**打开 requireAuthentication：那会让每次读令牌都弹生物识别。生物识别属于
/// 确认闸门的判据（Contract 的 ACTION_CONFIRM），不是"读取令牌"的默认前提。
public struct KeychainSecureStore: SecureStore {
    /// Keychain 的可访问性策略（测试直接断言这个常量被写进了 add 查询 —— 策略不能只是注释）。
    ///
    /// 用计算属性而不是 static let：CFString 非 Sendable，存成静态存储会让 Swift 6 的
    /// 并发检查直接判红（"not concurrency-safe"）。
    public static var accessibility: CFString { kSecAttrAccessibleWhenUnlockedThisDeviceOnly }

    public let service: String

    public init(service: String = "com.dshtrading.ios-native") {
        self.service = service
    }

    /// 定位一条通用密码项（不含 value，用于 load/delete）。
    public static func lookupAttributes(service: String, key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    /// 写入一条通用密码项的完整查询（含可访问性策略）。公开以便测试断言策略真的传给了平台。
    public static func addAttributes(service: String, key: String, value: String) -> [String: Any] {
        var attributes = lookupAttributes(service: service, key: key)
        attributes[kSecValueData as String] = Data(value.utf8)
        attributes[kSecAttrAccessible as String] = accessibility
        return attributes
    }

    public func save(_ key: String, _ value: String) throws {
        // 幂等 upsert：先删再加（Keychain 的 add 遇到重复项会返回 errSecDuplicateItem）。
        let deleteStatus = SecItemDelete(KeychainSecureStore.lookupAttributes(service: service, key: key) as CFDictionary)
        guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
            throw KeychainError(status: deleteStatus)
        }
        let status = SecItemAdd(KeychainSecureStore.addAttributes(service: service, key: key, value: value) as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func load(_ key: String) throws -> String? {
        var query = KeychainSecureStore.lookupAttributes(service: service, key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError(status: status) }
        return String(decoding: data, as: UTF8.self)
    }

    public func remove(_ key: String) throws {
        let status = SecItemDelete(KeychainSecureStore.lookupAttributes(service: service, key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// 内存安全存储：**契约假件**（实现同一 SecureStore 接口），供测试与预览使用。
///
/// 与 apps/mobile 的 createMemoryKeyValue 同一角色：它让凭据逻辑（fail-closed 解析、
/// 解绑、绑定地址）可以在不碰真 Keychain 的前提下被真实调用路径覆盖。
/// **不要**在生产路径上用它存真凭据。
public final class InMemorySecureStore: SecureStore, @unchecked Sendable {
    private var map: [String: String]
    private let lock = NSLock()

    public init(_ initial: [String: String] = [:]) {
        self.map = initial
    }

    public func save(_ key: String, _ value: String) throws {
        lock.lock(); defer { lock.unlock() }
        map[key] = value
    }

    public func load(_ key: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return map[key]
    }

    public func remove(_ key: String) throws {
        lock.lock(); defer { lock.unlock() }
        map.removeValue(forKey: key)
    }

    /// 给测试看"后端里到底还剩什么"（解绑后必须为空，不是只清内存缓存）。
    public var dump: [String: String] {
        lock.lock(); defer { lock.unlock() }
        return map
    }
}
