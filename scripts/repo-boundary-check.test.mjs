import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  packageDirViolations,
  importViolationsIn,
  vendorSourceViolations,
  trackedTarballViolations,
} from './repo-boundary-check.mjs'

function fixture() {
  return mkdtempSync(join(tmpdir(), 'repo-boundary-'))
}

describe('repo-boundary-check', () => {
  it('管理员：主仓出现 packages/bot 之类的实现包会被抓出来（BD1）', () => {
    // Given 一个把自动交易包重新长回来的主仓
    const root = fixture()
    mkdirSync(join(root, 'packages', 'tradectl'), { recursive: true })
    writeFileSync(join(root, 'packages', 'tradectl', 'package.json'), '{}')
    // When 检查包目录
    const problems = packageDirViolations(root)
    // Then 报出来
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('BD1')
    expect(problems[0]).toContain('tradectl')
    rmSync(root, { recursive: true, force: true })
  })

  it('管理员：没有实现包时 BD1 放行（别把守卫修成永真）', () => {
    // Given 干净主仓
    const root = fixture()
    mkdirSync(join(root, 'packages', 'base'), { recursive: true })
    writeFileSync(join(root, 'packages', 'base', 'package.json'), '{}')
    // When / Then
    expect(packageDirViolations(root)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('管理员：源码级 import 自动交易包会被抓出来（BD2）', () => {
    // Given 一行真实 import
    const text = "import { createEdgeGateway } from '@dshtrading/tradectl/lib/edge.js'"
    // When / Then
    const problems = importViolationsIn(text, 'desktop/tests/x.mjs')
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('第 1 行')
  })

  it('管理员：注释里提到包名放行（接缝必须可被记录，否则等于禁止写事实）', () => {
    // Given 只把包名写在注释里
    const text = '// 实现已迁往私有卫星仓：@dshtrading/bot 不再在主仓'
    // When / Then
    expect(importViolationsIn(text, 'scripts/x.mjs')).toEqual([])
  })

  it('管理员：写一行 repo-boundary-allow 附理由即可豁免（豁免必须显式可审查）', () => {
    // Given 带豁免标记的真实 import
    const text = "import { x } from '@dshtrading/bot' // repo-boundary-allow: 说明接缝形态\n"
    // When / Then
    expect(importViolationsIn(text, 'scripts/seam.mjs')).toEqual([])
  })

  it('管理员：vendor 槽位里的解包源码会被抓出来（BD3——只许产物）', () => {
    // Given vendor 下既有产物又有解包源码
    const root = fixture()
    mkdirSync(join(root, 'vendor', 'dshtrading-bot-0.5.0'), { recursive: true })
    writeFileSync(join(root, 'vendor', 'dshtrading-bot-0.5.0.tgz'), '')
    // When
    const problems = vendorSourceViolations(root)
    // Then 只报解包目录，产物放行
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('BD3')
    rmSync(root, { recursive: true, force: true })
  })

  it('管理员：强制提交含自动交易源码的 tgz 会被抓出来（BD4——gitignore 挡不住 --force）', () => {
    // Given 一个被 git add --force 的 tar，里面是 tradectl 的编译产物
    const tarballs = ['desktop/satellite-vendor/dshtrading-tradectl-0.5.0.tgz']
    const entries = 'package/lib/api-v1.js\npackage/lib/edge.js\npackage/package.json\n'
    // When / Then
    const problems = trackedTarballViolations(tarballs, () => entries)
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('BD4')
    expect(problems[0]).toContain('tradectl')
  })

  it('管理员：主仓自己的 tar 产物不算违规（守卫别把正常打包也拦了）', () => {
    // Given 主仓 connector 的 tar，路径里没有卫星包名
    const tarballs = ['desktop/resources/runtime/profile-trading/vendor/dshtrading-base-0.5.0.tgz']
    const entries = 'package/lib/index.js\n'
    // When / Then
    expect(trackedTarballViolations(tarballs, () => entries)).toEqual([])
  })
})
