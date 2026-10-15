/**
 * expectLocaleKeyParity 的行为测试：证明词典真漂移时这个 helper 会红。
 */
import { describe, expect, it } from 'vitest'
import { expectLocaleKeyParity } from '../src/index.ts'

describe('词典对齐 helper', () => {
  it('运营对齐词典时 zh/en 键集合与 {placeholder} 一致不报错', () => {
    // Given: 键集合与每键 {placeholder} 都对齐的两份词典
    const zh = { 'demo.hello': '你好 {name}，共 {count} 条' }
    const en = { 'demo.hello': 'Hello {name}, {count} rows' }
    // When: 调用共享 helper
    // Then: 全部检查通过，不抛错
    expect(() => expectLocaleKeyParity(zh, en)).not.toThrow()
  })

  it('运营发现 zh 有键而 en 缺键时报错', () => {
    // Given: zh 多一个键（en 缺键）的词典对
    const zh = { 'demo.hello': '你好', 'demo.extra': '多余' }
    const en = { 'demo.hello': 'Hello' }
    // When: 调用共享 helper
    // Then: 键集合双向差集断言失败报错
    expect(() => expectLocaleKeyParity(zh, en)).toThrow()
  })

  it('运营发现同一键 {placeholder} 漂移时报错', () => {
    // Given: 键集合对齐、但同一键 {placeholder} 集合不同的词典对
    const zh = { 'demo.hello': '你好 {name}' }
    const en = { 'demo.hello': 'Hello {other}' }
    // When: 调用共享 helper
    // Then: 占位符集合断言失败报错
    expect(() => expectLocaleKeyParity(zh, en)).toThrow()
  })
})
