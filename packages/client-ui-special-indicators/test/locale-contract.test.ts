/**
 * 词典契约测试（私有包不进 i18n-audit 中心包门禁——那会给已发布 dsh-i18n
 * 引入对私有包的 workspace 依赖；zh/en 对齐改由本用例调用 @dshtrading/test-support
 * 的 expectLocaleKeyParity 钉住，口径与 scripts/i18n-audit.mjs 相同：
 * 键集合双向对齐 + {placeholder} 对齐）。
 */
import { describe, it } from 'vitest'
import { expectLocaleKeyParity } from '@dshtrading/test-support'
import { en, zh } from '../src/client/locales.ts'

describe('特殊指标词典 zh/en 契约', () => {
  it('运营维护词典时 zh/en 键集合与 {placeholder} 双向对齐', () => {
    // Given: zh/en 两份词典
    // When: 逐键比对键集合与占位符集合
    // Then: 双向无缺失且插值面零漂移（en 下不会渲染出空占位符）
    expectLocaleKeyParity(zh, en)
  })
})
