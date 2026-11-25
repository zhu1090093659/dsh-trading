/**
 * dsh-trading-tool CLI 回环免代理保护单测。
 */
import { describe, expect, it } from 'vitest'
import { ensureLoopbackNoProxy } from '../bin/dsh-trading-tool.mjs'

describe('dsh-trading-tool 回环免代理守卫', () => {
  it('用户：存在代理环境变量时自动补全 localhost/127.0.0.1/::1 到 NO_PROXY，无代理变量或已有 * 时不改写', () => {
    // Given: 含代理环境变量但缺回环绕过的环境对象、无代理环境对象、已含 * 的环境对象
    const withProxy: Record<string, string | undefined> = {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: 'internal.corp',
    }
    const withoutProxy: Record<string, string | undefined> = { PATH: '/usr/bin' }
    const wildcardProxy: Record<string, string | undefined> = {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: '*',
    }
    // When: 执行回环保护
    ensureLoopbackNoProxy(withProxy)
    ensureLoopbackNoProxy(withoutProxy)
    ensureLoopbackNoProxy(wildcardProxy)
    // Then: 仅前者补齐 loopback 条目并保留原有条目
    expect(withProxy.NO_PROXY).toBe('internal.corp,localhost,127.0.0.1,::1,[::1]')
    expect(withProxy.no_proxy).toBe(withProxy.NO_PROXY)
    expect(withoutProxy.NO_PROXY).toBeUndefined()
    expect(wildcardProxy.NO_PROXY).toBe('*')
  })
})
