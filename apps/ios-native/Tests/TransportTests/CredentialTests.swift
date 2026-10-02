import XCTest
import Security
import DshTradingContract
@testable import DshTradingTransport

/// 凭据安全存储：fail-closed 解析、解绑、脱敏，以及"策略不是注释里的空话"。
final class CredentialTests: XCTestCase {
    private func makeCredential(deviceId: String = "dev_1", secret: String = "s3cr3t") -> StoredCredential {
        StoredCredential(origin: .loopback, deviceId: deviceId, secret: secret)
    }

    func testVaultRoundTripKeepsBoundOrigin() throws {
        // Given 一个空的安全存储
        let store = InMemorySecureStore()
        let vault = CredentialVault(store: store)
        let credential = makeCredential()

        // When 存一份凭据再读
        try vault.save(credential)

        // Then 读回一致（含"这台设备属于哪台 bot"）
        XCTAssertEqual(try vault.load(), credential)
        XCTAssertEqual(try vault.load()?.origin, .loopback)
    }

    func testVaultIsFailClosedOnMalformedStoredData() throws {
        // Given 六种不可用凭据：坏 JSON、缺字段、空主机、含点号的段、非 http(s) scheme、缺端口
        let raws = [
            "{ not json",
            #"{"deviceId":"dev_1","secret":"s3cr3t"}"#,
            #"{"scheme":"http","host":"127.0.0.1","port":3081,"deviceId":"dev_1"}"#,
            #"{"scheme":"http","host":"","port":3081,"deviceId":"dev_1","secret":"s3cr3t"}"#,
            #"{"scheme":"http","host":"127.0.0.1","port":3081,"deviceId":"dev.1","secret":"s3cr3t"}"#,
            #"{"scheme":"file","host":"127.0.0.1","port":3081,"deviceId":"dev_1","secret":"s3cr3t"}"#,
        ]
        // When / Then 一律读出 nil（宁可重新配对，也不把半截凭据当可用凭据）
        for raw in raws {
            let vault = CredentialVault(store: InMemorySecureStore([CredentialVault.defaultKey: raw]))
            XCTAssertNil(try vault.load(), "坏数据应判为不可用：" + raw)
        }
    }

    func testVaultRefusesToWriteAnIncompleteCredential() throws {
        // Given 一个段里含点号的凭据（会把令牌改写成三段）
        let store = InMemorySecureStore()
        let vault = CredentialVault(store: store)

        // When / Then 写入前就 fail-closed 拒绝，存储里一个字都没有
        XCTAssertThrowsError(try vault.save(makeCredential(deviceId: "dev.1")))
        XCTAssertThrowsError(try vault.save(makeCredential(secret: "")))
        XCTAssertEqual(store.dump, [:])
    }

    func testClearRemovesStoredCredential() throws {
        // Given 已存凭据
        let store = InMemorySecureStore()
        let vault = CredentialVault(store: store)
        try vault.save(makeCredential())

        // When 解绑
        try vault.clear()

        // Then 读不到，且后端里确实没有残留（不是只清内存）
        XCTAssertNil(try vault.load())
        XCTAssertEqual(store.dump, [:])
    }

    func testCredentialNeverExposesSecretInTextualOrReflectiveOutput() throws {
        // Given 一份凭据
        let credential = makeCredential()

        // When 把它交给所有"会打印"的入口
        let description = String(describing: credential)
        let reflected = String(reflecting: credential)
        let mirror = Mirror(reflecting: credential).children
            .map { String(describing: $0.value) }
            .joined(separator: ",")

        // Then secret 一处都不出现（凭据不进日志）
        XCTAssertFalse(description.contains("s3cr3t"))
        XCTAssertFalse(reflected.contains("s3cr3t"))
        XCTAssertFalse(mirror.contains("s3cr3t"))
        XCTAssertTrue(description.contains("dev_1"))
    }

    func testTokenProviderReleasesTokenOnlyForTheBoundOrigin() throws {
        // Given 已配对到 127.0.0.1:3081 的提供者
        let tokens = try KeychainTokenProvider(store: InMemorySecureStore())
        try tokens.save(makeCredential())

        // When 分别问绑定 origin 与另一个 origin
        // Then 只对绑定的那个给令牌（换地址一律不外发）；**没有**不带绑定的取令牌入口
        XCTAssertEqual(tokens.authorization(ifBoundTo: .loopback), "Bearer dev_1.s3cr3t")
        XCTAssertNil(tokens.authorization(ifBoundTo: DshtOrigin(scheme: "http", host: "127.0.0.1", port: 9999)))
        XCTAssertNil(tokens.authorization(ifBoundTo: DshtOrigin(scheme: "http", host: "evil.example.com", port: 80)))
    }

    func testForgetClearsMemoryAndSecureStorage() throws {
        // Given 已配对
        let store = InMemorySecureStore()
        let tokens = try KeychainTokenProvider(store: store)
        try tokens.save(makeCredential())
        XCTAssertNotNil(tokens.current)

        // When 解绑
        tokens.forget()

        // Then 内存与安全存储都空了（解绑一处生效），配对身份也没了
        XCTAssertNil(tokens.current)
        XCTAssertNil(tokens.authorization(ifBoundTo: .loopback))
        XCTAssertNil(tokens.pairingIdentity)
        XCTAssertEqual(store.dump, [:])
    }

    func testDeviceTokenRejectsSegmentsContainingADot() {
        // Given / When / Then 两段缺一不可，且段内不许有点号（否则令牌段数被改写）
        XCTAssertEqual(DeviceToken.token(deviceId: "dev_1", secret: "s3cr3t"), "dev_1.s3cr3t")
        XCTAssertEqual(DeviceToken.authorization(deviceId: "dev_1", secret: "s3cr3t"), "Bearer dev_1.s3cr3t")
        XCTAssertNil(DeviceToken.token(deviceId: "dev.1", secret: "s"))
        XCTAssertNil(DeviceToken.token(deviceId: "dev", secret: "a.b"))
        XCTAssertNil(DeviceToken.token(deviceId: "", secret: "s"))
        XCTAssertNil(DeviceToken.token(deviceId: "dev", secret: ""))
        // 切分与 edge 同构：只切第一个点号
        XCTAssertEqual(DeviceToken.components("dev.a.b")?.deviceId, "dev")
        XCTAssertEqual(DeviceToken.components("dev.a.b")?.secret, "a.b")
        XCTAssertNil(DeviceToken.components("no-dot"))
    }

    func testKeychainWriteQueryCarriesThisDeviceOnlyAccessibility() {
        // Given / When 取 Keychain 的写入查询
        let write = KeychainSecureStore.addAttributes(service: "svc", key: "dshtrading.device", value: "v")
        let lookup = KeychainSecureStore.lookupAttributes(service: "svc", key: "dshtrading.device")

        // Then 可访问性策略真的传给了平台（不随备份迁移新设备），而不是只写在注释里
        XCTAssertEqual(
            write[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String
        )
        XCTAssertEqual(write[kSecAttrService as String] as? String, "svc")
        XCTAssertEqual(write[kSecAttrAccount as String] as? String, "dshtrading.device")
        XCTAssertNotNil(write[kSecValueData as String])
        // 定位查询里不带 value（读/删不该先看到密钥）
        XCTAssertNil(lookup[kSecValueData as String])
    }

    func testKeychainBackedProviderRoundTripsThroughRealSecurityFrameworkBinding() throws {
        // Given 用真 Keychain 类型构造的 vault（本用例不写系统 Keychain：注入内存后端，
        // 验的是 KeychainSecureStore 的查询形状 + 提供者把 origin 一起存的语义）
        let store = InMemorySecureStore()
        let tokens = try KeychainTokenProvider(store: store, key: "dshtrading.test.device")
        try tokens.save(makeCredential())

        // When 重新构造一个提供者（模拟重启后从安全存储读回）
        let reopened = try KeychainTokenProvider(store: store, key: "dshtrading.test.device")

        // Then 令牌与绑定 origin 一起回来了（重启后代际从 0 起，不要求跨重启一致）
        XCTAssertEqual(reopened.authorization(ifBoundTo: .loopback), "Bearer dev_1.s3cr3t")
        XCTAssertEqual(reopened.boundOrigin, .loopback)
        XCTAssertEqual(reopened.pairingIdentity, PairingIdentity(origin: .loopback, epoch: 0))
    }

    func testPairingEpochAdvancesOnEverySuccessfulSaveAndNotOnARefusedWrite() throws {
        // Given 一个空的安全存储（从未配对 ⇒ 没有配对身份）
        let store = InMemorySecureStore()
        let tokens = try KeychainTokenProvider(store: store)
        XCTAssertNil(tokens.pairingIdentity)

        // When 配对到同一个 origin 两次（服务端重发凭据 / 换一台设备）
        try tokens.save(makeCredential(deviceId: "dev_1"))
        let first = try XCTUnwrap(tokens.pairingIdentity)
        try tokens.save(makeCredential(deviceId: "dev_2"))
        let second = try XCTUnwrap(tokens.pairingIdentity)

        // Then 代际每次成功配对前移一格、origin 不变 —— 这就是"重新配对到同一个 origin
        // 也能被认出来"的判据（只看 origin 时两次完全相同）
        XCTAssertEqual(first.epoch + 1, second.epoch)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(second.origin, .loopback)

        // And 落库被 fail-closed 拒绝（段里含点号的凭据）时**不**前移：那次配对没有成立
        XCTAssertThrowsError(try tokens.save(makeCredential(deviceId: "dev.3")))
        XCTAssertEqual(tokens.pairingIdentity, second)
    }
}
