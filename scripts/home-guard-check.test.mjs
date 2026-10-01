/**
 * home 守卫门禁的自测：证明它会红、也会因显式豁免而放行。
 * 与 contract-id 的门禁自测同一风格（伪造样本必须能被抓出来）。
 */
import { describe, expect, it } from 'vitest'
import { violationsIn } from './home-guard-check.mjs'

const D = String.fromCharCode(36)

describe('home-guard-check', () => {
  it('管理员：读了 DSH_HOME 却没有守卫记号的脚本会被抓出来', () => {
    const body = 'const home = process.env.DSH_HOME' + String.fromCharCode(10) + 'console.log(home)'
    const found = violationsIn(body, 'scripts/foo.mjs')
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('DSH_HOME')
  })

  it('管理员：带 -trading 守卫记号的脚本放行', () => {
    const body = 'const home = process.env.DSH_HOME' + String.fromCharCode(10) + "if (!home.includes('-trading')) process.exit(2)"
    expect(violationsIn(body, 'scripts/foo.mjs')).toEqual([])
  })

  it('管理员：没有守卫的 shell 读取（回落宿主 home）会被抓出来', () => {
    // 样本里**不能**出现 -trading，否则它自带守卫记号（第一版就是这么写错的）
    const body = 'DSH_HOME="' + D + '{DSH_HOME:-' + D + 'HOME/.dsh}"'
    expect(violationsIn(body, 'scripts/foo.sh')).toHaveLength(1)
  })

  it('管理员：注释里提到 DSH_HOME 不算读取', () => {
    const body = '# 用法：DSH_HOME=... node scripts/foo.mjs'
    expect(violationsIn(body, 'scripts/foo.sh')).toEqual([])
  })

  it('管理员：显式豁免标记（home-guard-allow）放行，但理由要写在源码里', () => {
    const body = '// home-guard-allow: 测试把 DSH_HOME 钉到 mkdtemp 临时目录' + String.fromCharCode(10) + 'process.env.DSH_HOME = home'
    expect(violationsIn(body, 'packages/x/test/y.test.ts')).toEqual([])
  })
})
