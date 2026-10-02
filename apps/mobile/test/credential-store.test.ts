/**
 * 凭据存储的测试：用内存后端（契约假件，实现同一 SecureKeyValue 接口）。
 */
import { describe, expect, it } from 'vitest'
import { createCredentialStore, createMemoryKeyValue } from '../src/credential-store.ts'

const DEVICE = { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read', 'command'], baseUrl: 'http://127.0.0.1:3081' }

describe('设备凭据存储', () => {
  it('管理员：存了能读回，且字段原样（scopes 与绑定地址都不丢）', async () => {
    // Given 一个空的内存后端
    const backend = createMemoryKeyValue()
    const store = createCredentialStore(backend)
    // When 存一份凭据再读
    await store.save(DEVICE)
    const loaded = await store.load()
    // Then 读回一致（含"这台设备属于哪台 bot"）
    expect(loaded).toEqual(DEVICE)
    expect(loaded?.baseUrl).toBe('http://127.0.0.1:3081')
  })

  it('管理员：没存过时读出 null（不抛错）', async () => {
    // Given 空后端
    const store = createCredentialStore(createMemoryKeyValue())
    // When 读
    // Then null
    expect(await store.load()).toBeNull()
  })

  it('管理员：存储里是坏 JSON 或缺字段时读出 null（宁可重新配对，也不用半截凭据）', async () => {
    // Given 后端里放了坏数据
    const broken = createMemoryKeyValue({ 'dshtrading.device': '{ not json' })
    const partial = createMemoryKeyValue({ 'dshtrading.device': JSON.stringify({ deviceId: 'dev_1' }) })
    // When 读
    // Then 都判为不可用
    expect(await createCredentialStore(broken).load()).toBeNull()
    expect(await createCredentialStore(partial).load()).toBeNull()
  })

  it('管理员：缺绑定地址或地址不是绝对 URL 时读出 null（坏地址不许进请求路径）', async () => {
    // Given 三种不可用凭据：旧格式（无 baseUrl）、空地址、相对地址
    const legacy = createMemoryKeyValue({ 'dshtrading.device': JSON.stringify({ deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'] }) })
    const blank = createMemoryKeyValue({ 'dshtrading.device': JSON.stringify({ ...DEVICE, baseUrl: '' }) })
    const relative = createMemoryKeyValue({ 'dshtrading.device': JSON.stringify({ ...DEVICE, baseUrl: '/pair/redeem' }) })
    // When 读
    // Then 都判为不可用（宁可重新配对，也不拿一个不知道发给谁的令牌）
    expect(await createCredentialStore(legacy).load()).toBeNull()
    expect(await createCredentialStore(blank).load()).toBeNull()
    expect(await createCredentialStore(relative).load()).toBeNull()
  })

  it('管理员：clear 之后读不到，且后端里确实没有残留', async () => {
    // Given 已存凭据
    const backend = createMemoryKeyValue()
    const store = createCredentialStore(backend)
    await store.save(DEVICE)
    // When 清除
    await store.clear()
    // Then 读不到，且后端的键也没了（不是只清缓存）
    expect(await store.load()).toBeNull()
    expect(Object.keys(backend.dump())).toEqual([])
  })
})
