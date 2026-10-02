/**
 * 设备鉴权纯逻辑测试：配对请求体形态、响应 → 令牌、存储存取。无 mock 无 sleep（内存存储对象）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEVICE_TOKEN_STORAGE_KEY,
  forgetToken,
  loadStoredToken,
  pairRequestBody,
  storeToken,
  tokenFromPairResponse,
  type TokenStorage,
} from '../src/auth.ts'

function memoryStorage(): TokenStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) }
}

describe('配对请求体', () => {
  it('管理员：code 去空白、name 缺省给 web-cockpit 且截到 64 字符、scopes 显式只要 read+command', () => {
    // Given 各种输入形态
    // When 组装
    const body = pairRequestBody('  ABC123  ', '')
    const long = pairRequestBody('X', 'n'.repeat(100))
    // Then 与 edge 侧上限一致；control 不在请求里（永不默认签发）
    expect(body).toEqual({ code: 'ABC123', name: 'web-cockpit', scopes: ['read', 'command'] })
    expect(long.name).toHaveLength(64)
    expect(long.scopes).not.toContain('control')
  })
})

describe('配对响应 → 令牌', () => {
  it('管理员：deviceId.secret 组成 Bearer 令牌；缺任一字段返回 undefined（不存半个令牌）', () => {
    // Given 完整响应与两种残缺响应
    const ok = tokenFromPairResponse({ deviceId: 'dev_0123456789abcdef', secret: 's3cret', scopes: ['read'], deniedScopes: [] })
    const noSecret = tokenFromPairResponse({ deviceId: 'dev_0123456789abcdef', secret: '', scopes: [], deniedScopes: [] })
    const noId = tokenFromPairResponse(undefined as never)
    // Then
    expect(ok).toBe('dev_0123456789abcdef.s3cret')
    expect(noSecret).toBeUndefined()
    expect(noId).toBeUndefined()
  })
})

describe('令牌存储', () => {
  it('管理员：存取走固定键；空串当没有；解绑删键（401 与用户主动解绑共用一条路）', () => {
    // Given 一个内存存储
    const storage = memoryStorage()
    // Then 初始没有令牌
    expect(loadStoredToken(storage)).toBeUndefined()
    // When 存再读
    storeToken(storage, 'dev_0123456789abcdef.t')
    expect(loadStoredToken(storage)).toBe('dev_0123456789abcdef.t')
    expect(storage.map.get(DEVICE_TOKEN_STORAGE_KEY)).toBe('dev_0123456789abcdef.t')
    // When 空串与解绑
    storeToken(storage, '')
    expect(loadStoredToken(storage)).toBeUndefined()
    storeToken(storage, 't2')
    forgetToken(storage)
    // Then 键被删掉
    expect(storage.map.has(DEVICE_TOKEN_STORAGE_KEY)).toBe(false)
  })
})
