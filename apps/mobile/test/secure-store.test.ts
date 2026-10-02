/**
 * expo-secure-store 适配器的测试：用**同形状的内存实现**（契约假件）跑真实调用路径，
 * 断言的不只是"存得进读得出"，还有"选项真的传给了平台"—— 令牌不随备份迁移这类策略
 * 如果没传下去，就是一句写在注释里的空话。
 */
import { describe, expect, it } from 'vitest'
import { createCredentialStore } from '../src/credential-store.ts'
import { createSecureStoreKeyValue, type SecureStoreOptionsLike } from '../src/secure-store.ts'

interface Call {
  readonly op: 'get' | 'set' | 'del'
  readonly key: string
  readonly options: SecureStoreOptionsLike | undefined
}

/** 契约假件：实现 expo-secure-store 的三个异步函数（内存语义），并记录每次调用的选项。 */
function createFakeSecureStore(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  const calls: Call[] = []
  return {
    calls,
    dump: () => Object.fromEntries(map.entries()),
    async getItemAsync(key: string, options?: SecureStoreOptionsLike) {
      calls.push({ op: 'get', key, options })
      return map.has(key) ? (map.get(key) as string) : null
    },
    async setItemAsync(key: string, value: string, options?: SecureStoreOptionsLike) {
      calls.push({ op: 'set', key, options })
      map.set(key, value)
    },
    async deleteItemAsync(key: string, options?: SecureStoreOptionsLike) {
      calls.push({ op: 'del', key, options })
      map.delete(key)
    },
  }
}

const KEYCHAIN_ACCESSIBLE = 4 // 上游是数字常量（SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY）

describe('expo-secure-store 适配器', () => {
  it('管理员：凭据经适配器存进平台存储，再读回一致（键名固定）', async () => {
    // Given 一个空的平台存储
    const backend = createFakeSecureStore()
    const store = createCredentialStore(createSecureStoreKeyValue(backend))
    const device = { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'], baseUrl: 'http://127.0.0.1:3081' }
    // When 存一份凭据再读
    await store.save(device)
    // Then 读回一致，且落在固定的键上（凭据不在别处）
    expect(await store.load()).toEqual(device)
    expect(Object.keys(backend.dump())).toEqual(['dshtrading.device'])
  })

  it('管理员：写入与删除都把可访问性/服务名传给平台（策略不是注释里的空话）', async () => {
    // Given 用 THIS_DEVICE_ONLY 策略包装的存储
    const backend = createFakeSecureStore()
    const store = createCredentialStore(
      createSecureStoreKeyValue(backend, { keychainAccessible: KEYCHAIN_ACCESSIBLE, keychainService: 'dshtrading.device' }),
    )
    // When 存一份再清掉
    await store.save({ deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'], baseUrl: 'http://127.0.0.1:3081' })
    await store.clear()
    // Then 写入与删除都带上了这些选项（读回的 get 同样带 service）
    expect(backend.calls.map((call) => call.op)).toEqual(['set', 'del'])
    expect(backend.calls[0]?.options).toEqual({ keychainAccessible: KEYCHAIN_ACCESSIBLE, keychainService: 'dshtrading.device' })
    expect(backend.calls[1]?.options).toEqual({ keychainAccessible: KEYCHAIN_ACCESSIBLE, keychainService: 'dshtrading.device' })
  })

  it('管理员：clear 真的删掉平台条目（解绑不是只清内存）', async () => {
    // Given 已存凭据的平台存储
    const backend = createFakeSecureStore()
    const store = createCredentialStore(createSecureStoreKeyValue(backend))
    await store.save({ deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'], baseUrl: 'http://127.0.0.1:3081' })
    // When 解绑
    await store.clear()
    // Then 平台存储里没有残留，读回 null
    expect(backend.dump()).toEqual({})
    expect(await store.load()).toBeNull()
  })

  it('管理员：平台里没有条目时读出 null（未配对不是错误）', async () => {
    // Given 空平台存储
    const backend = createFakeSecureStore()
    const store = createCredentialStore(createSecureStoreKeyValue(backend))
    // When 读
    // Then null，且确实问过平台
    expect(await store.load()).toBeNull()
    expect(backend.calls.map((call) => call.key)).toEqual(['dshtrading.device'])
  })
})
