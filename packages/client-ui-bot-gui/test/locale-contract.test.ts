/**
 * 词典契约测试：zh/en 键位与 {placeholder} 对齐。
 * 断言体由 @dshtrading/test-support 的 expectLocaleKeyParity 承载（三个私有
 * client-ui 包共用一份，不再各抄一份）。
 */
import { describe, it } from 'vitest'
import { expectLocaleKeyParity } from '@dshtrading/test-support'
import { en, zh } from '../src/client/locales.ts'

describe('机器人控制台词典 zh/en 契约', () => {
  it('运营维护词典时 zh/en 键集合与 {placeholder} 双向对齐', () => {
    // Given: zh/en 两份词典
    // When: 逐键比对键集合与占位符集合
    // Then: 双向无缺失且插值面零漂移
    expectLocaleKeyParity(zh, en)
  })
})
