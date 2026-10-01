/**
 * 凭据存储的测试：用内存后端（契约假件，实现同一 SecureKeyValue 接口）。
 */
import { describe, expect, it } from 'vitest'
import { createCredentialStore, createMemoryKeyValue } from '../src/credential-store.ts'

const DEVICE = { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read', 'command'] }

describe('设备凭据存储', () => {
  it('管理员：存了能读回，且字段原样（scopes 不丢）', async () => {
    // Given 一个空的内存后端
    const backend = createMemoryKeyValue()
    const store = createCredentialStore(backend)
    // When 存一份凭据再读
    await store.save(DEVICE)
    const loaded = await store.load()
    // Then 读回一致
    expect(loaded).toEqual(DEVICE)
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
