/**
 * home 守卫门禁的自测：证明它会红、也会因显式豁免而放行。
 * 与 contract-id 的门禁自测同一风格（伪造样本必须能被抓出来）。
 */
import { describe, expect, it } from 'vitest'
import { violationsIn } from './home-guard-check.mjs'

const D = String.fromCharCode(36)
const NL = String.fromCharCode(10)

describe('home-guard-check', () => {
  it('管理员：读了 DSH_HOME 却没有守卫记号的脚本会被抓出来', () => {
    // Given 一个只读 DSH_HOME、没有任何守卫的脚本
    const body = 'const home = process.env.DSH_HOME' + NL + 'console.log(home)'
    // When 过门禁
    const found = violationsIn(body, 'scripts/foo.mjs')
    // Then 被抓出来且指明是 DSH_HOME 的问题
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('DSH_HOME')
  })

  it('管理员：带 -trading 守卫记号的脚本放行', () => {
    // Given 一个读了 DSH_HOME 但带守卫的脚本
    const body = 'const home = process.env.DSH_HOME' + NL + "if (!home.includes('-trading')) process.exit(2)"
    // When 过门禁
    // Then 放行
    expect(violationsIn(body, 'scripts/foo.mjs')).toEqual([])
  })

  it('管理员：没有守卫的 shell 读取（回落宿主 home）会被抓出来', () => {
    // Given 一个回落到宿主 home 的 shell 读取（样本里**不能**出现 -trading，否则自带守卫记号）
    const body = 'DSH_HOME="' + D + '{DSH_HOME:-' + D + 'HOME/.dsh}"'
    // When 过门禁
    // Then 违规一条
    expect(violationsIn(body, 'scripts/foo.sh')).toHaveLength(1)
  })

  it('管理员：注释里提到 DSH_HOME 不算读取', () => {
    // Given 一行只是用法说明的注释
    const body = '# 用法：DSH_HOME=... node scripts/foo.mjs'
    // When 过门禁
    // Then 不违规（避免把文档写成债）
    expect(violationsIn(body, 'scripts/foo.sh')).toEqual([])
  })

  it('管理员：显式豁免标记（home-guard-allow）放行，但理由要写在源码里', () => {
    // Given 一个带豁免标记与理由的测试片段
    const body = '// home-guard-allow: 测试把 DSH_HOME 钉到 mkdtemp 临时目录' + NL + 'process.env.DSH_HOME = home'
    // When 过门禁
    // Then 放行
    expect(violationsIn(body, 'packages/x/test/y.test.ts')).toEqual([])
  })
})
